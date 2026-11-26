using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("AJAZZ TTX Setup")]
[assembly: AssemblyDescription("AJAZZ Stream Dock monitor setup")]
[assembly: AssemblyCompany("Auskraft")]
[assembly: AssemblyVersion("1.7.0.0")]

internal static class Setup
{
    private const string Product = "AJAZZ ТТХ";
    private const string TaskName = "Auskraft Ajazz TTX CPU Sensor";
    private const string FpsTaskName = "Auskraft Ajazz TTX FPS Sensor";
    private const string DriverHash = "1F519A22E47187F70A1379A48CA604981C4FCF694F4E65B734AAA74A9FBA3032";
    private const string PluginFile = "com.auskraft.ajazz.ttx.sdPlugin";
    private const string SensorExe = "CpuSensor.exe";
    private const string SensorData = "cpu-temperature.json";
    private const string FpsCaptureExe = "FpsCapture.exe";
    private const string PresentMonExe = "PresentMon.exe";
    private const string FpsSessionName = "Auskraft-Ajazz-FPS-Broker";

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--install-sensors")
            {
                InstallSensors(new SecurityIdentifier(args[1]));
                return 0;
            }

            if (!StreamDockRegistered())
            {
                MessageBox.Show("Сначала установи фирменную программу Stream Dock AJAZZ Global.", Product,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 1;
            }

            var choice = MessageBox.Show(
                "Да — установить плагин, фоновый датчик CPU и вентиляторов платы, а также захват FPS по запросу кнопки. Windows попросит подтвердить установку.\n\n" +
                "Нет — установить только плагин.\n\nОтмена — выйти.",
                Product, MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (choice == DialogResult.Cancel) return 0;

            if (choice == DialogResult.Yes && !StartSensorSetup()) return 1;
            ImportPlugin();
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, Product, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static bool StreamDockRegistered()
    {
        using (var key = Registry.ClassesRoot.OpenSubKey(".sdPlugin"))
        {
            return key != null && key.GetValue("") is string;
        }
    }

    private static bool StartSensorSetup()
    {
        string userSid;
        using (var identity = WindowsIdentity.GetCurrent())
            userSid = identity.User.Value;
        using (var setup = Process.Start(new ProcessStartInfo
        {
            FileName = Assembly.GetExecutingAssembly().Location,
            Arguments = "--install-sensors " + userSid,
            Verb = "runas",
            UseShellExecute = true
        }))
        {
            setup.WaitForExit();
            return setup.ExitCode == 0;
        }
    }

    private static void ImportPlugin()
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Auskraft", "AjazzTTX", "Installer");
        Directory.CreateDirectory(folder);
        var target = Path.Combine(folder, PluginFile);
        using (var package = OpenPackage())
            Extract(package, PluginFile, target);
        Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true });
    }

    private static ZipArchive OpenPackage()
    {
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
        if (stream == null) throw new IOException("Установочный архив отсутствует.");
        return new ZipArchive(stream, ZipArchiveMode.Read);
    }

    private static void Extract(ZipArchive package, string entryName, string target)
    {
        var entry = package.GetEntry(entryName);
        if (entry == null) throw new IOException("В установочном архиве отсутствует " + entryName);
        WriteEntry(entry, target);
    }

    private static void RejectReparsePoint(string path)
    {
        if ((Directory.Exists(path) || File.Exists(path)) &&
            (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Папка установки или файл является ссылкой: " + path);
    }

    private static void WriteEntry(ZipArchiveEntry entry, string target)
    {
        RejectReparsePoint(target);
        var temporary = Path.Combine(Path.GetDirectoryName(target), Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var source = entry.Open())
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write))
                source.CopyTo(output);
            if (File.Exists(target)) File.Replace(temporary, target, null);
            else File.Move(temporary, target);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static void InstallSensors(SecurityIdentifier userSid)
    {
        if (!Environment.Is64BitOperatingSystem || Environment.OSVersion.Platform != PlatformID.Win32NT)
            throw new PlatformNotSupportedException("Фоновые датчики рассчитаны на 64-битную Windows.");

        var prefix = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Auskraft");
        RejectReparsePoint(prefix);
        var folder = Path.Combine(prefix, "AjazzTTX");
        RejectReparsePoint(folder);
        Directory.CreateDirectory(folder);
        ProtectSensorFolder(folder);
        var presentMon = Path.Combine(folder, PresentMonExe);
        bool replacingFpsSensor = File.Exists(presentMon);

        dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
        service.Connect();
        dynamic tasks = service.GetFolder("\\");
        using (var package = OpenPackage())
        {
            InstallDriver(package, folder);
            StopExistingTask(tasks, TaskName);
            StopExistingTask(tasks, FpsTaskName);
            foreach (var entry in package.Entries)
            {
                if (!entry.FullName.StartsWith("cpu/", StringComparison.Ordinal)) continue;
                var name = entry.FullName.Substring("cpu/".Length);
                if (name != Path.GetFileName(name) || (name != SensorExe && !name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)))
                    continue;
                WriteEntry(entry, Path.Combine(folder, name));
            }
            Extract(package, "fps/" + FpsCaptureExe, Path.Combine(folder, FpsCaptureExe));
            Extract(package, "fps/" + PresentMonExe, presentMon);
            Extract(package, "fps/LICENSE-PresentMon.txt", Path.Combine(folder, "LICENSE-PresentMon.txt"));
        }
        if (replacingFpsSensor) StopFpsTrace(presentMon, folder);

        var exe = Path.Combine(folder, SensorExe);
        var data = Path.Combine(folder, SensorData);
        RejectReparsePoint(exe);
        RejectReparsePoint(data);
        if (!File.Exists(exe)) throw new IOException("Датчик CPU отсутствует в установочном архиве.");
        RegisterTask(service, tasks, exe, data, folder);
        RegisterFpsTask(service, tasks, folder, userSid);
    }

    private static void StopFpsTrace(string executable, string folder)
    {
        using (var process = Process.Start(new ProcessStartInfo
        {
            FileName = executable,
            Arguments = "--session_name " + FpsSessionName + " --terminate_existing_session --no_csv --no_console_stats",
            WorkingDirectory = folder,
            UseShellExecute = false,
            CreateNoWindow = true
        }))
        {
            if (!process.WaitForExit(3000)) process.Kill();
        }
    }

    private static void ProtectSensorFolder(string folder)
    {
        var acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        acl.SetOwner(admins);
        acl.AddAccessRule(new FileSystemAccessRule(admins, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(users, FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(folder, acl);
    }

    private static bool DriverInstalled()
    {
        using (var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\PawnIO"))
            return key != null;
    }

    private static void InstallDriver(ZipArchive package, string folder)
    {
        if (DriverInstalled()) return;
        var driver = Path.Combine(folder, "PawnIO-" + Guid.NewGuid().ToString("N") + ".exe");
        try
        {
            Extract(package, "PawnIO_setup.exe", driver);
            using (var sha = SHA256.Create())
            using (var file = File.OpenRead(driver))
            {
                var hash = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "");
                if (!string.Equals(hash, DriverHash, StringComparison.Ordinal))
                    throw new IOException("Контрольная сумма установщика PawnIO не совпала.");
            }
            using (var process = Process.Start(new ProcessStartInfo
            {
                FileName = driver, Arguments = "-install", UseShellExecute = true, WorkingDirectory = folder
            }))
            {
                process.WaitForExit();
                if (!DriverInstalled())
                    throw new IOException("Установка PawnIO не завершилась. Код " + process.ExitCode + ".");
            }
        }
        finally
        {
            if (File.Exists(driver)) File.Delete(driver);
        }
    }

    private static void StopExistingTask(dynamic folder, string taskName)
    {
        foreach (dynamic task in folder.GetTasks(0))
        {
            if (task.Name != taskName) continue;
            if ((int)task.State != 2 && (int)task.State != 4) return;
            task.Stop(0);
            for (int attempt = 0; attempt < 30 && (int)task.State == 4; attempt++)
                Thread.Sleep(200);
            if ((int)task.State == 4) throw new IOException("Предыдущая версия датчика ещё работает.");
            return;
        }
    }

    private static void RegisterTask(dynamic service, dynamic folder, string exe, string data, string working)
    {
        dynamic definition = service.NewTask(0);
        definition.RegistrationInfo.Description = "Reads CPU temperature and motherboard fan speed for AJAZZ TTX.";
        definition.Principal.UserId = "SYSTEM";
        definition.Principal.LogonType = 5;
        definition.Principal.RunLevel = 1;
        definition.Settings.ExecutionTimeLimit = "PT0S";
        definition.Settings.StartWhenAvailable = true;
        definition.Settings.MultipleInstances = 2;
        definition.Settings.DisallowStartIfOnBatteries = false;
        definition.Settings.StopIfGoingOnBatteries = false;
        definition.Settings.RestartCount = 3;
        definition.Settings.RestartInterval = "PT1M";
        definition.Triggers.Create(8);
        dynamic action = definition.Actions.Create(0);
        action.Path = exe;
        action.Arguments = "--publish \"" + data + "\"";
        action.WorkingDirectory = working;
        dynamic task = folder.RegisterTaskDefinition(TaskName, definition, 6, "SYSTEM", null, 5, null);
        task.Run(null);
    }

    private static void RegisterFpsTask(dynamic service, dynamic folder, string working, SecurityIdentifier userSid)
    {
        dynamic definition = service.NewTask(0);
        definition.RegistrationInfo.Description = "Streams frame timing to AJAZZ TTX on demand.";
        definition.Principal.UserId = "SYSTEM";
        definition.Principal.LogonType = 5;
        definition.Principal.RunLevel = 1;
        definition.Settings.AllowDemandStart = true;
        definition.Settings.ExecutionTimeLimit = "PT0S";
        definition.Settings.MultipleInstances = 1;
        definition.Settings.DisallowStartIfOnBatteries = false;
        definition.Settings.StopIfGoingOnBatteries = false;
        dynamic action = definition.Actions.Create(0);
        action.Path = Path.Combine(working, FpsCaptureExe);
        action.Arguments = "--user-sid " + userSid.Value;
        action.WorkingDirectory = working;
        string descriptor = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;" + userSid.Value + ")";
        folder.RegisterTaskDefinition(FpsTaskName, definition, 6, "SYSTEM", null, 5, descriptor);
    }
}
