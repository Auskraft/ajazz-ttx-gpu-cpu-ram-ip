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
[assembly: AssemblyVersion("1.2.0.0")]

internal static class Setup
{
    private const string Product = "AJAZZ ТТХ";
    private const string TaskName = "Auskraft Ajazz TTX CPU Sensor";
    private const string DriverHash = "1F519A22E47187F70A1379A48CA604981C4FCF694F4E65B734AAA74A9FBA3032";
    private const string PluginFile = "com.auskraft.ajazz.ttx.sdPlugin";
    private const string SensorExe = "CpuSensor.exe";
    private const string SensorData = "cpu-temperature.json";

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--install-cpu")
            {
                InstallCpu();
                return 0;
            }

            if (!StreamDockRegistered())
            {
                MessageBox.Show("Сначала установи фирменную программу Stream Dock AJAZZ Global.", Product,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 1;
            }

            var choice = MessageBox.Show(
                "Да — установить плагин и датчик температуры CPU. Windows запросит права администратора для установки подписанного драйвера PawnIO и фонового датчика.\n\n" +
                "Нет — установить плагин без датчика температуры CPU.\n\nОтмена — выйти.",
                Product, MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (choice == DialogResult.Cancel) return 0;

            if (choice == DialogResult.Yes && !StartCpuSetup()) return 1;
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

    private static bool StartCpuSetup()
    {
        using (var setup = Process.Start(new ProcessStartInfo
        {
            FileName = Assembly.GetExecutingAssembly().Location,
            Arguments = "--install-cpu",
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

    private static void InstallCpu()
    {
        if (!Environment.Is64BitOperatingSystem || Environment.OSVersion.Platform != PlatformID.Win32NT)
            throw new PlatformNotSupportedException("Датчик температуры рассчитан на 64-битную Windows.");

        var prefix = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Auskraft");
        RejectReparsePoint(prefix);
        var folder = Path.Combine(prefix, "AjazzTTX");
        RejectReparsePoint(folder);
        Directory.CreateDirectory(folder);
        ProtectSensorFolder(folder);

        dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
        service.Connect();
        dynamic tasks = service.GetFolder("\\");
        using (var package = OpenPackage())
        {
            InstallDriver(package, folder);
            StopExistingTask(tasks);
            foreach (var entry in package.Entries)
            {
                if (!entry.FullName.StartsWith("cpu/", StringComparison.Ordinal)) continue;
                var name = entry.FullName.Substring("cpu/".Length);
                if (name != Path.GetFileName(name) || (name != SensorExe && !name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)))
                    continue;
                WriteEntry(entry, Path.Combine(folder, name));
            }
        }

        var exe = Path.Combine(folder, SensorExe);
        var data = Path.Combine(folder, SensorData);
        RejectReparsePoint(exe);
        RejectReparsePoint(data);
        if (!File.Exists(exe)) throw new IOException("Датчик CPU отсутствует в установочном архиве.");
        RegisterTask(service, tasks, exe, data, folder);
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

    private static void StopExistingTask(dynamic folder)
    {
        foreach (dynamic task in folder.GetTasks(0))
        {
            if (task.Name != TaskName) continue;
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
        definition.RegistrationInfo.Description = "Reads the CPU package temperature for AJAZZ TTX.";
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
}
