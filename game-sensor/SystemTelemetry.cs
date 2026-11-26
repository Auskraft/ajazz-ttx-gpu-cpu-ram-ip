using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Threading;

internal sealed class SystemTelemetry
{
    [Flags]
    private enum Metrics
    {
        None = 0,
        Disk = 1,
        Network = 2,
        ProcessCpu = 4,
        ProcessRam = 8,
        ProcessGpu = 16,
        All = Disk | Network | ProcessCpu | ProcessRam | ProcessGpu
    }

    private const int IntervalMs = 1000;
    private const string DiskQuery = "SELECT Name, DiskReadBytesPersec, DiskWriteBytesPersec, PercentIdleTime, " +
        "PercentIdleTime_Base, Timestamp_PerfTime, Frequency_PerfTime FROM Win32_PerfRawData_PerfDisk_LogicalDisk";
    private const string GpuQuery = "SELECT Name, UtilizationPercentage, Timestamp_Sys100NS " +
        "FROM Win32_PerfRawData_GPUPerformanceCounters_GPUEngine";
    private static readonly uint RouteProbeIPv4 = BitConverter.ToUInt32(IPAddress.Parse("1.1.1.1").GetAddressBytes(), 0);
    private static readonly byte[] RouteProbeIPv6 = IPv6RouteAddress();
    private Dictionary<string, DiskCounters> diskBaseline = new Dictionary<string, DiskCounters>();
    private Dictionary<string, NetworkCounters> networkBaseline = new Dictionary<string, NetworkCounters>();
    private Dictionary<int, ProcessCounters> processBaseline = new Dictionary<int, ProcessCounters>();
    private Dictionary<string, GpuEngineCounters> gpuBaseline = new Dictionary<string, GpuEngineCounters>();

    public static int Run(string[] args, Action<object> emit)
    {
        var sensor = new SystemTelemetry();
        if (args.Length == 2 && args[1] == "--once")
        {
            sensor.Sample(Metrics.All);
            Thread.Sleep(IntervalMs);
            emit(sensor.Sample(Metrics.All));
            return 0;
        }
        if (args.Length != 1) return 2;

        int demand = 0;
        using (var exited = new ManualResetEvent(false))
        using (var changed = new AutoResetEvent(false))
        {
            var events = new WaitHandle[] { exited, changed };
            var input = new Thread(() =>
            {
                try
                {
                    string command;
                    while ((command = Console.ReadLine()) != null)
                    {
                        string[] tokens = command.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        if (tokens.Length == 0 || tokens[0] != "watch") continue;
                        int next = (int)RequestedMetrics(tokens);
                        if (Interlocked.Exchange(ref demand, next) != next) changed.Set();
                    }
                }
                catch (IOException) { }
                finally { exited.Set(); }
            }) { IsBackground = true };
            input.Start();

            while (!exited.WaitOne(0))
            {
                var requested = (Metrics)Thread.VolatileRead(ref demand);
                var clock = Stopwatch.StartNew();
                object sample = sensor.Sample(requested);
                if (requested != Metrics.None) emit(sample);
                int signal;
                do
                {
                    int wait = requested == Metrics.None ? Timeout.Infinite : Math.Max(0, IntervalMs - (int)clock.ElapsedMilliseconds);
                    signal = WaitHandle.WaitAny(events, wait);
                } while (signal == 1 && (Metrics)Thread.VolatileRead(ref demand) == requested);
            }
        }
        return 0;
    }

    private static Metrics RequestedMetrics(string[] tokens)
    {
        var result = Metrics.None;
        for (int index = 1; index < tokens.Length; index++)
        {
            switch (tokens[index])
            {
                case "disk": result |= Metrics.Disk; break;
                case "network": result |= Metrics.Network; break;
                case "process-cpu": result |= Metrics.ProcessCpu; break;
                case "process-ram": result |= Metrics.ProcessRam; break;
                case "process-gpu": result |= Metrics.ProcessGpu; break;
            }
        }
        return result;
    }

    private object Sample(Metrics requested)
    {
        List<object> disks = null, interfaces = null;
        string defaultInterfaceId = null;
        object topCpu = null, topRam = null, topGpu = null;
        if ((requested & Metrics.Disk) != 0) disks = ReadDisks();
        else diskBaseline.Clear();
        if ((requested & Metrics.Network) != 0) interfaces = ReadNetwork(out defaultInterfaceId);
        else networkBaseline.Clear();
        if ((requested & Metrics.ProcessCpu) == 0) processBaseline.Clear();
        if ((requested & (Metrics.ProcessCpu | Metrics.ProcessRam)) != 0)
            ReadProcesses(requested, out topCpu, out topRam);
        if ((requested & Metrics.ProcessGpu) != 0) topGpu = ReadGpuProcess();
        else gpuBaseline.Clear();
        return new { disks, interfaces, defaultInterfaceId, topCpu, topRam, topGpu };
    }

    private sealed class DiskCounters
    {
        public ulong Read, Write, Idle, IdleClock, Clock, Frequency;
    }

    private List<object> ReadDisks()
    {
        var next = new Dictionary<string, DiskCounters>();
        var readings = new List<object>();
        try
        {
            using (var query = PerformanceQuery(DiskQuery))
            using (var rows = query.Get())
            {
                foreach (ManagementBaseObject row in rows)
                {
                    using (row)
                    {
                        string name = Convert.ToString(row["Name"], CultureInfo.InvariantCulture);
                        if (name.Length != 2 || name[0] < 'A' || name[0] > 'Z' || name[1] != ':') continue;
                        string letter = name.Substring(0, 1);
                        var current = new DiskCounters
                        {
                            Read = Counter(row, "DiskReadBytesPersec"),
                            Write = Counter(row, "DiskWriteBytesPersec"),
                            Idle = Counter(row, "PercentIdleTime"),
                            IdleClock = Counter(row, "PercentIdleTime_Base"),
                            Clock = Counter(row, "Timestamp_PerfTime"),
                            Frequency = Counter(row, "Frequency_PerfTime")
                        };
                        next[letter] = current;
                        double? read = null, write = null, active = null;
                        DiskCounters previous;
                        if (diskBaseline.TryGetValue(letter, out previous))
                        {
                            if (current.Clock > previous.Clock && current.Frequency != 0)
                            {
                                double seconds = (current.Clock - previous.Clock) / (double)current.Frequency;
                                if (current.Read >= previous.Read) read = (current.Read - previous.Read) / seconds;
                                if (current.Write >= previous.Write) write = (current.Write - previous.Write) / seconds;
                            }
                            if (current.IdleClock > previous.IdleClock && current.Idle >= previous.Idle)
                            {
                                double idleShare = (current.Idle - previous.Idle) / (double)(current.IdleClock - previous.IdleClock);
                                active = BoundPercent(100 * (1 - idleShare));
                            }
                        }
                        readings.Add(new { letter, readBytesPerSecond = read, writeBytesPerSecond = write, activePercent = active });
                    }
                }
            }
        }
        catch (ManagementException) { }
        catch (UnauthorizedAccessException) { }
        catch (COMException) { }
        diskBaseline = next;
        return readings;
    }

    private static ManagementObjectSearcher PerformanceQuery(string query)
    {
        var options = new EnumerationOptions { Timeout = TimeSpan.FromMilliseconds(750) };
        return new ManagementObjectSearcher(new ManagementScope(@"root\CIMv2"), new ObjectQuery(query), options);
    }

    private static ulong Counter(ManagementBaseObject row, string name)
    {
        return Convert.ToUInt64(row[name], CultureInfo.InvariantCulture);
    }

    private sealed class NetworkCounters
    {
        public long Receive, Send, Clock;
    }

    private List<object> ReadNetwork(out string defaultInterfaceId)
    {
        var next = new Dictionary<string, NetworkCounters>();
        var readings = new List<object>();
        uint ipv4Index, ipv6Index;
        bool route4 = GetBestInterface(RouteProbeIPv4, out ipv4Index) == 0;
        bool route6 = GetBestInterfaceEx(RouteProbeIPv6, out ipv6Index) == 0;
        string ipv4Default = null, ipv6Default = null;
        try
        {
            foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (adapter.NetworkInterfaceType == NetworkInterfaceType.Loopback ||
                    adapter.OperationalStatus == OperationalStatus.NotPresent) continue;
                bool ipv4 = adapter.Supports(NetworkInterfaceComponent.IPv4);
                bool ipv6 = adapter.Supports(NetworkInterfaceComponent.IPv6);
                if (!ipv4 && !ipv6) continue;
                string id = adapter.Id;
                string name = adapter.Name;
                double? receive = null, send = null;
                if (adapter.OperationalStatus == OperationalStatus.Up)
                {
                    try
                    {
                        IPInterfaceStatistics stats = adapter.GetIPStatistics();
                        var current = new NetworkCounters { Receive = stats.BytesReceived, Send = stats.BytesSent, Clock = Stopwatch.GetTimestamp() };
                        next[id] = current;
                        NetworkCounters previous;
                        if (networkBaseline.TryGetValue(id, out previous) && current.Clock > previous.Clock)
                        {
                            double seconds = (current.Clock - previous.Clock) / (double)Stopwatch.Frequency;
                            if (current.Receive >= previous.Receive) receive = (current.Receive - previous.Receive) / seconds;
                            if (current.Send >= previous.Send) send = (current.Send - previous.Send) / seconds;
                        }
                    }
                    catch (NetworkInformationException) { }
                    try
                    {
                        IPInterfaceProperties properties = adapter.GetIPProperties();
                        IPv4InterfaceProperties properties4 = route4 && ipv4 ? properties.GetIPv4Properties() : null;
                        IPv6InterfaceProperties properties6 = route6 && ipv6 ? properties.GetIPv6Properties() : null;
                        if (properties4 != null && properties4.Index == ipv4Index) ipv4Default = id;
                        if (properties6 != null && properties6.Index == ipv6Index) ipv6Default = id;
                    }
                    catch (NetworkInformationException) { }
                }
                readings.Add(new { id, name, receiveBytesPerSecond = receive, sendBytesPerSecond = send });
            }
        }
        catch (NetworkInformationException) { }
        networkBaseline = next;
        defaultInterfaceId = ipv4Default ?? ipv6Default;
        return readings;
    }

    private static byte[] IPv6RouteAddress()
    {
        // sockaddr_in6, AF_INET6=23; both port and scope are zero for the public route lookup.
        var address = new byte[28];
        address[0] = 23;
        Array.Copy(IPAddress.Parse("2606:4700:4700::1111").GetAddressBytes(), 0, address, 8, 16);
        return address;
    }

    private sealed class ProcessCounters
    {
        public long Started, CpuTicks, Clock;
    }

    private void ReadProcesses(Metrics requested, out object cpu, out object ram)
    {
        cpu = null;
        ram = null;
        Process[] processes;
        try { processes = Process.GetProcesses(); }
        catch (InvalidOperationException) { processBaseline.Clear(); return; }
        catch (Win32Exception) { processBaseline.Clear(); return; }
        bool watchCpu = (requested & Metrics.ProcessCpu) != 0;
        bool watchRam = (requested & Metrics.ProcessRam) != 0;
        var next = new Dictionary<int, ProcessCounters>();
        uint logical = watchCpu ? GetActiveProcessorCount(ushort.MaxValue) : 0;
        double logicalProcessors = logical > 0 ? logical : (double)Environment.ProcessorCount;
        int sensorPid;
        using (Process sensor = Process.GetCurrentProcess()) sensorPid = sensor.Id;
        long mostRam = -1;
        double mostCpu = -1;
        foreach (Process process in processes)
        {
            using (process)
            {
                int pid;
                string name;
                try
                {
                    pid = process.Id;
                    if (pid == sensorPid || pid == 0) continue;
                    name = process.ProcessName;
                }
                catch (InvalidOperationException) { continue; }
                catch (Win32Exception) { continue; }

                if (watchRam)
                {
                    try
                    {
                        // Working set is resident physical memory, including pages shared with other processes.
                        long memoryBytes = process.WorkingSet64;
                        if (memoryBytes > mostRam)
                        {
                            mostRam = memoryBytes;
                            ram = new { name, pid, memoryBytes };
                        }
                    }
                    catch (InvalidOperationException) { }
                    catch (Win32Exception) { }
                }
                if (watchCpu)
                {
                    try
                    {
                        var current = new ProcessCounters
                        {
                            Started = process.StartTime.ToUniversalTime().Ticks,
                            CpuTicks = process.TotalProcessorTime.Ticks,
                            Clock = Stopwatch.GetTimestamp()
                        };
                        next[pid] = current;
                        ProcessCounters previous;
                        if (!processBaseline.TryGetValue(pid, out previous) || current.Started != previous.Started ||
                            current.Clock <= previous.Clock || current.CpuTicks < previous.CpuTicks) continue;
                        double elapsedSeconds = (current.Clock - previous.Clock) / (double)Stopwatch.Frequency;
                        double processorSeconds = (current.CpuTicks - previous.CpuTicks) / (double)TimeSpan.TicksPerSecond;
                        double cpuPercent = BoundPercent(100 * processorSeconds / (elapsedSeconds * logicalProcessors));
                        if (cpuPercent > mostCpu)
                        {
                            mostCpu = cpuPercent;
                            cpu = new { name, pid, cpuPercent };
                        }
                    }
                    catch (InvalidOperationException) { }
                    catch (Win32Exception) { }
                }
            }
        }
        processBaseline = next;
    }

    private struct GpuEngineCounters
    {
        public ulong RunningTime, Clock;
    }

    private struct GpuUsage
    {
        public double Percent;
        public ulong PreviousClock;
    }

    private object ReadGpuProcess()
    {
        var next = new Dictionary<string, GpuEngineCounters>();
        var busiestEngines = new Dictionary<int, GpuUsage>();
        try
        {
            using (var query = PerformanceQuery(GpuQuery))
            using (var rows = query.Get())
            {
                foreach (ManagementBaseObject row in rows)
                {
                    using (row)
                    {
                        string engine = Convert.ToString(row["Name"], CultureInfo.InvariantCulture);
                        int pid;
                        if (!TryReadGpuPid(engine, out pid)) continue;

                        // The raw PERF_100NSEC_TIMER value is accumulated GPU time in the clock's units.
                        var counter = new GpuEngineCounters
                        {
                            RunningTime = Counter(row, "UtilizationPercentage"),
                            Clock = Counter(row, "Timestamp_Sys100NS")
                        };
                        next[engine] = counter;
                        GpuEngineCounters previous;
                        if (!gpuBaseline.TryGetValue(engine, out previous) || previous.Clock == 0 ||
                            counter.Clock <= previous.Clock || counter.RunningTime <= previous.RunningTime) continue;

                        double percent = BoundPercent(100.0 * (counter.RunningTime - previous.RunningTime) /
                            (counter.Clock - previous.Clock));
                        // Engines may run in parallel. Task Manager represents each process by its busiest engine.
                        GpuUsage busiest;
                        if (!busiestEngines.TryGetValue(pid, out busiest) || percent > busiest.Percent)
                            busiestEngines[pid] = new GpuUsage { Percent = percent, PreviousClock = previous.Clock };
                    }
                }
            }
        }
        catch (ManagementException) { gpuBaseline.Clear(); return null; }
        catch (UnauthorizedAccessException) { gpuBaseline.Clear(); return null; }
        catch (COMException) { gpuBaseline.Clear(); return null; }
        gpuBaseline = next;

        object top = null;
        double bestPercent = 0;
        foreach (var processUsage in busiestEngines)
        {
            var sample = processUsage.Value;
            if (sample.Percent <= bestPercent) continue;
            int pid = processUsage.Key;
            try
            {
                using (Process process = Process.GetProcessById(pid))
                {
                    // A process created after the older sample may have inherited a released PID.
                    if ((ulong)process.StartTime.ToFileTimeUtc() > sample.PreviousClock || process.HasExited) continue;
                    string name = process.ProcessName;
                    bestPercent = sample.Percent;
                    top = new { name, pid, gpuPercent = sample.Percent };
                }
            }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            catch (Win32Exception) { }
        }
        return top;
    }

    private static bool TryReadGpuPid(string engine, out int pid)
    {
        pid = 0;
        if (!engine.StartsWith("pid_", StringComparison.Ordinal)) return false;
        int end = engine.IndexOf('_', 4);
        return end > 4 && int.TryParse(engine.Substring(4, end - 4), NumberStyles.None,
            CultureInfo.InvariantCulture, out pid) && pid > 0;
    }

    private static double BoundPercent(double value)
    {
        return Math.Max(0, Math.Min(100, value));
    }

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("iphlpapi.dll", ExactSpelling = true)]
    private static extern uint GetBestInterface(uint destination, out uint interfaceIndex);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("iphlpapi.dll", ExactSpelling = true)]
    private static extern uint GetBestInterfaceEx([In] byte[] destination, out uint interfaceIndex);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern uint GetActiveProcessorCount(ushort group);
}
