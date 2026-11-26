using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class FpsCapture
{
    private const string PipePath = @"\\.\pipe\Auskraft-Ajazz-TTX-Fps-v1";
    private const string SessionName = "Auskraft-Ajazz-FPS-Broker";
    private const string CaptureOptions = "--stop_existing_session --output_stdout --v2_metrics --exclude_dropped " +
        "--no_console_stats --no_track_input --no_track_gpu";
    private const uint Duplex = 0x00000003;
    private const uint FirstPipeInstance = 0x00080000;
    private const uint Overlapped = 0x40000000;
    private const uint RejectRemoteClients = 0x00000008;
    private const uint QueryProcess = 0x1000;
    private const uint QueryToken = 0x0008;
    private const uint KillOnJobClose = 0x00002000;
    private const int ExtendedJobLimits = 9;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

    public static int Main(string[] args)
    {
        if (args.Length != 2 || args[0] != "--user-sid") return 2;
        try
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
                if (!identity.IsSystem) return 3;
            var user = new SecurityIdentifier(args[1]);
            using (NamedPipeServerStream pipe = OpenPipe(user))
            {
                IAsyncResult connecting = pipe.BeginWaitForConnection(null, null);
                if (!connecting.AsyncWaitHandle.WaitOne(10000)) return 0;
                pipe.EndWaitForConnection(connecting);

                uint session;
                if (!GetNamedPipeClientSessionId(pipe.SafePipeHandle, out session) || session == 0 ||
                    !MatchesClientUser(pipe.SafePipeHandle, user)) return 4;

                Capture(pipe, session);
                return 0;
            }
        }
        catch (ArgumentException) { return 2; }
        catch (IOException) { return 1; }
        catch (UnauthorizedAccessException) { return 1; }
        catch (Win32Exception) { return 1; }
        catch (InvalidOperationException) { return 1; }
    }

    private static NamedPipeServerStream OpenPipe(SecurityIdentifier user)
    {
        // The owner is SYSTEM; anonymous and network clients have no route into the broker.
        var acl = new RawSecurityDescriptor("O:SYG:SYD:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;" + user.Value + ")");
        var bytes = new byte[acl.BinaryLength];
        acl.GetBinaryForm(bytes, 0);
        GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            var security = new SecurityAttributes
            {
                Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                Descriptor = pinned.AddrOfPinnedObject()
            };
            SafePipeHandle handle = CreateNamedPipeW(PipePath, Duplex | FirstPipeInstance | Overlapped,
                RejectRemoteClients, 1, 65536, 512, 0, ref security);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error);
            }
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
            catch { handle.Dispose(); throw; }
        }
        finally { pinned.Free(); }
    }

    private static bool MatchesClientUser(SafePipeHandle pipe, SecurityIdentifier expected)
    {
        uint pid;
        if (!GetNamedPipeClientProcessId(pipe, out pid)) return false;
        IntPtr process = OpenProcess(QueryProcess, false, pid);
        if (process == IntPtr.Zero) return false;
        try
        {
            IntPtr token;
            if (!OpenProcessToken(process, QueryToken, out token)) return false;
            try
            {
                using (var client = new WindowsIdentity(token))
                    return expected.Equals(client.User);
            }
            finally { CloseHandle(token); }
        }
        finally { CloseHandle(process); }
    }

    private static void Capture(NamedPipeServerStream pipe, uint session)
    {
        // The client has no command channel. Any byte or disconnect ends capture.
        byte[] input = new byte[1];
        IAsyncResult disconnected = pipe.BeginRead(input, 0, input.Length, null, null);
        if (disconnected.IsCompleted) return;
        using (SafeFileHandle job = CreateCaptureJob())
        using (Process capture = StartPresentMon(CaptureOptions))
        {
            var forwarding = new Thread(() =>
            {
                try { Forward(capture.StandardOutput, pipe, session); }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
            }) { IsBackground = true };
            try
            {
                if (!AssignProcessToJobObject(job, capture.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
                capture.BeginErrorReadLine();
                forwarding.Start();
                while (!disconnected.AsyncWaitHandle.WaitOne(150) && !capture.HasExited && forwarding.IsAlive) { }
            }
            finally
            {
                pipe.Dispose();
                StopCapture(capture);
                if (forwarding.IsAlive) forwarding.Join(2000);
            }
        }
    }

    private static SafeFileHandle CreateCaptureJob()
    {
        SafeFileHandle job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        if (job.IsInvalid)
        {
            int code = Marshal.GetLastWin32Error();
            job.Dispose();
            throw new Win32Exception(code);
        }
        var limits = new JobExtendedLimits();
        limits.Basic.Flags = KillOnJobClose;
        if (SetInformationJobObject(job, ExtendedJobLimits, ref limits, (uint)Marshal.SizeOf(typeof(JobExtendedLimits))))
            return job;
        int error = Marshal.GetLastWin32Error();
        job.Dispose();
        throw new Win32Exception(error);
    }

    private static Process StartPresentMon(string options)
    {
        string folder = AppDomain.CurrentDomain.BaseDirectory;
        string executable = Path.Combine(folder, "PresentMon.exe");
        var start = new ProcessStartInfo(executable, "--session_name " + SessionName + " " + options)
        {
            WorkingDirectory = folder,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Utf8,
            StandardErrorEncoding = Utf8
        };
        Process process = Process.Start(start);
        if (process == null) throw new InvalidOperationException("PresentMon could not start.");
        return process;
    }

    private static void StopCapture(Process capture)
    {
        try
        {
            using (Process stop = StartPresentMon("--terminate_existing_session --no_csv --no_console_stats"))
            {
                stop.BeginOutputReadLine();
                stop.BeginErrorReadLine();
                if (!stop.WaitForExit(3000)) stop.Kill();
            }
        }
        catch (Win32Exception) { }
        catch (InvalidOperationException) { }
        finally
        {
            try { if (!capture.WaitForExit(1500)) capture.Kill(); }
            catch (Win32Exception) { }
            catch (InvalidOperationException) { }
        }
    }

    private static void Forward(TextReader source, Stream target, uint session)
    {
        int fields = 0;
        using (var output = new StreamWriter(target, Utf8, 4096, true) { AutoFlush = true })
        {
            string row;
            while ((row = source.ReadLine()) != null)
            {
                if (row.Length > 8192) continue;
                if (fields == 0)
                {
                    if (!row.StartsWith("Application,ProcessID,SwapChainAddress,", StringComparison.Ordinal) ||
                        row.IndexOf(",DisplayedTime", StringComparison.Ordinal) < 0) continue;
                    fields = row.Split(',').Length;
                    output.WriteLine(row);
                    continue;
                }

                uint pid, rowSession;
                if (ReadPid(row, fields, out pid) && ProcessIdToSessionId(pid, out rowSession) && rowSession == session)
                    output.WriteLine(row);
            }
        }
    }

    private static bool ReadPid(string row, int expectedFields, out uint pid)
    {
        pid = 0;
        // PresentMon does not escape commas in executable names. Count fixed fields from the right.
        int comma = row.Length;
        for (int column = expectedFields - 1; column >= 2; column--)
        {
            if (comma <= 0) return false;
            comma = row.LastIndexOf(',', comma - 1);
        }
        if (comma <= 0) return false;
        int pidStart = row.LastIndexOf(',', comma - 1) + 1;
        return pidStart > 0 && uint.TryParse(row.Substring(pidStart, comma - pidStart),
            NumberStyles.None, CultureInfo.InvariantCulture, out pid) && pid != 0;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr Descriptor;
        internal int Inherit;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobBasicLimits
    {
        internal long ProcessUserTime, JobUserTime;
        internal uint Flags;
        internal UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobExtendedLimits
    {
        internal JobBasicLimits Basic;
        internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode,
        uint instances, uint outSize, uint inSize, uint timeout, ref SecurityAttributes security);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint session);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, IntPtr name);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, ref JobExtendedLimits limits, uint length);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
}
