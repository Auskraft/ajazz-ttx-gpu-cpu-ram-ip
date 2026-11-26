using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class ForegroundProcess
{
    private const int PollIntervalMilliseconds = 250;
    private static readonly ManualResetEvent InputClosed = new ManualResetEvent(false);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    private static uint GetForegroundProcessId()
    {
        IntPtr window = GetForegroundWindow();
        uint processId;
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out processId) == 0)
            return 0;
        return processId;
    }

    private static void WaitForInputToClose()
    {
        try
        {
            using (Stream input = Console.OpenStandardInput())
            {
                // The parent keeps this pipe open for the lifetime of the helper.
                while (input.ReadByte() != -1) { }
            }
        }
        catch (IOException) { }
        finally
        {
            InputClosed.Set();
        }
    }

    private static void ListOpenApps()
    {
        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Process process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    if (process.MainWindowHandle != IntPtr.Zero)
                        names.Add(process.ProcessName + ".exe");
                }
                catch (InvalidOperationException) { }
                catch (Win32Exception) { }
            }
        }

        Console.OutputEncoding = new UTF8Encoding(false);
        foreach (string name in names)
            Console.WriteLine(name);
    }

    private static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--apps")
        {
            ListOpenApps();
            return;
        }
        if (args.Length != 0 || !Console.IsInputRedirected)
            return;

        var inputWatcher = new Thread(WaitForInputToClose) { IsBackground = true };
        inputWatcher.Start();

        uint? previous = null;
        try
        {
            do
            {
                uint processId = GetForegroundProcessId();
                if (previous != processId)
                {
                    Console.WriteLine(processId.ToString(CultureInfo.InvariantCulture));
                    previous = processId;
                }
            } while (!InputClosed.WaitOne(PollIntervalMilliseconds));
        }
        catch (IOException) { }
    }
}
