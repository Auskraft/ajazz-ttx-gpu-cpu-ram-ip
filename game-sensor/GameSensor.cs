using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class GameSensor
{
    private const double Gibibyte = 1073741824.0;
    private const string StorageNamespace = @"root\Microsoft\Windows\Storage";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly ManualResetEvent Exited = new ManualResetEvent(false);
    private static int toggleRequests;

    public static int Main(string[] args)
    {
        if (args.Length == 0) return 2;
        bool once = args[args.Length - 1] == "--once";
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args[0] == "output") return RunAudioOutput(args);
        if (!once)
        {
            var commands = new Thread(ReadCommands) { IsBackground = true };
            commands.Start();
        }

        switch (args[0])
        {
            case "microphone":
                RunMicrophone(once);
                break;
            case "network":
                if (args.Length < 2 || Uri.CheckHostName(args[1]) == UriHostNameType.Unknown) return 2;
                RunNetwork(args[1], once);
                break;
            case "disk":
                RunDisks(once);
                break;
            default:
                return 2;
        }
        return 0;
    }

    private static void ReadCommands()
    {
        try
        {
            string command;
            while ((command = Console.ReadLine()) != null)
            {
                if (command == "toggle") Interlocked.Increment(ref toggleRequests);
            }
        }
        catch (IOException) { }
        finally { Exited.Set(); }
    }

    private static void Emit(object sample)
    {
        Console.WriteLine(Json.Serialize(sample));
    }

    private static int RunAudioOutput(string[] args)
    {
        if (args.Length == 2 && args[1] == "--once")
        {
            Emit(HandleAudioOutput("list"));
            return 0;
        }
        if (args.Length == 3 && args[1] == "--switch")
        {
            Emit(HandleAudioOutput("switch " + args[2]));
            return 0;
        }
        if (args.Length != 1) return 2;

        Console.InputEncoding = new UTF8Encoding(false);
        string command;
        while ((command = Console.ReadLine()) != null) Emit(HandleAudioOutput(command));
        return 0;
    }

    private static object HandleAudioOutput(string command)
    {
        try
        {
            using (var outputs = new AudioOutput())
            {
                if (command == "list") return outputs.List();
                const string switchPrefix = "switch ";
                if (command.StartsWith(switchPrefix, StringComparison.Ordinal))
                    return new { switched = outputs.Switch(command.Substring(switchPrefix.Length)) };
            }
        }
        catch (COMException) { }
        return null;
    }

    private static void RunMicrophone(bool once)
    {
        using (var microphone = new Microphone(openMeterStream: !once))
        {
            var clock = Stopwatch.StartNew();
            long refreshAt = 0;
            do
            {
                if (clock.ElapsedMilliseconds >= refreshAt)
                {
                    microphone.Refresh();
                    refreshAt = clock.ElapsedMilliseconds + 1000;
                }

                if ((Interlocked.Exchange(ref toggleRequests, 0) & 1) == 1) microphone.Toggle();
                Emit(microphone.Sample());
            } while (!once && !Exited.WaitOne(125));
        }
    }

    private static void RunNetwork(string target, bool once)
    {
        using (var ping = new Ping())
        {
            do
            {
                long? pingMs = null;
                var clock = Stopwatch.StartNew();
                try
                {
                    var reply = ping.Send(target, 750);
                    if (reply.Status == IPStatus.Success) pingMs = reply.RoundtripTime;
                }
                catch (PingException) { }
                catch (ArgumentException) { }
                catch (InvalidOperationException) { }
                Emit(new { pingMs });
                if (once) return;
                if (Exited.WaitOne(Math.Max(20, 1000 - (int)clock.ElapsedMilliseconds))) return;
            } while (true);
        }
    }

    private static void RunDisks(bool once)
    {
        Dictionary<string, string> media = null;
        var age = Stopwatch.StartNew();
        do
        {
            if (media == null || age.ElapsedMilliseconds >= 30000)
            {
                media = ReadMediaTypes();
                age.Restart();
            }

            var disks = new List<object>();
            foreach (var volume in DriveInfo.GetDrives())
            {
                if (volume.DriveType != DriveType.Fixed && volume.DriveType != DriveType.Removable) continue;
                try
                {
                    if (!volume.IsReady) continue;
                    long total = volume.TotalSize;
                    if (total <= 0) continue;
                    long free = Math.Min(total, Math.Max(0, volume.TotalFreeSpace));
                    string letter = volume.Name.Substring(0, 1).ToUpperInvariant();
                    string type;
                    if (!media.TryGetValue(letter, out type)) type = "ДИСК";
                    disks.Add(new
                    {
                        letter,
                        type,
                        usedGb = Math.Round((total - free) / Gibibyte, 1),
                        totalGb = Math.Round(total / Gibibyte, 1),
                        freePct = Math.Round(100.0 * free / total),
                    });
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            Emit(disks);
        } while (!once && !Exited.WaitOne(5000));
    }

    private static Dictionary<string, string> ReadMediaTypes()
    {
        var volumes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var byUniqueId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            QueryStorage("SELECT UniqueId, MediaType FROM MSFT_PhysicalDisk", row =>
            {
                string id = Convert.ToString(row["UniqueId"], CultureInfo.InvariantCulture).Trim();
                int type = Convert.ToInt32(row["MediaType"], CultureInfo.InvariantCulture);
                if (id.Length > 0 && (type == 3 || type == 4)) byUniqueId[id] = type == 3 ? "HDD" : "SSD";
            });

            var byDiskNumber = new Dictionary<int, string>();
            QueryStorage("SELECT Number, UniqueId, BusType FROM MSFT_Disk", row =>
            {
                string id = Convert.ToString(row["UniqueId"], CultureInfo.InvariantCulture).Trim();
                string type;
                if (!byUniqueId.TryGetValue(id, out type) &&
                    Convert.ToInt32(row["BusType"], CultureInfo.InvariantCulture) == 17) type = "SSD";
                if (type != null) byDiskNumber[Convert.ToInt32(row["Number"], CultureInfo.InvariantCulture)] = type;
            });

            QueryStorage("SELECT DriveLetter, DiskNumber FROM MSFT_Partition", row =>
            {
                string letter = Convert.ToString(row["DriveLetter"], CultureInfo.InvariantCulture);
                string type;
                if (letter.Length == 1 && byDiskNumber.TryGetValue(Convert.ToInt32(row["DiskNumber"], CultureInfo.InvariantCulture), out type))
                    volumes[letter] = type;
            });
        }
        catch (ManagementException) { }
        catch (UnauthorizedAccessException) { }
        catch (System.Runtime.InteropServices.COMException) { }
        return volumes;
    }

    private static void QueryStorage(string query, Action<ManagementBaseObject> read)
    {
        using (var search = new ManagementObjectSearcher(StorageNamespace, query))
        using (var rows = search.Get())
        {
            foreach (ManagementBaseObject row in rows)
            {
                using (row) read(row);
            }
        }
    }
}
