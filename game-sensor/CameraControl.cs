using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

internal static class CameraControl
{
    private const string CameraClass = "{CA3E7AB9-B4C3-4AE6-8251-579EF933890F}";
    private const string CfgMgr = "cfgmgr32.dll";
    private const uint Success = 0;
    private const uint NoSuchDevNode = 0x0D;
    private const uint BufferSmall = 0x1A;
    private const uint PresentCameraClass = 0x100 | 0x200;
    private const uint IncludeDisabledInterfaces = 1;
    private const uint Started = 0x08;
    private const uint HasProblem = 0x400;
    private const uint Disableable = 0x2000;
    private const uint ProblemDisabled = 22;
    private const uint DisablePersistently = 0x08;
    private const uint SuppressDisableFailureUi = 0x04;
    private const uint FriendlyName = 0x0D;
    private const uint DeviceDescription = 1;
    private const uint RegistryString = 1;
    private const int UserCancelled = 1223;
    private const string Enabled = "enabled";
    private const string Disabled = "disabled";
    private const string Unavailable = "unavailable";
    private static readonly Guid AudioInterface = new Guid("6994AD04-93EF-11D0-A3CC-00A0C9223196");

    internal sealed class Result
    {
        public bool changed { get; private set; }
        public string status { get; private set; }
        public string reason { get; private set; }

        public Result(bool changed, string status, string reason = null)
        {
            this.changed = changed;
            this.status = status;
            this.reason = reason;
        }
    }

    private sealed class Device
    {
        public readonly string Id;
        public readonly uint Instance;
        public readonly string Status;

        public Device(string id, uint instance, string status)
        {
            Id = id;
            Instance = instance;
            Status = status;
        }
    }

    public static bool ValidId(string id)
    {
        // PnP instance IDs have a bus, device and instance component; 200 includes the null.
        if (string.IsNullOrEmpty(id) || id.Length >= 200 || id.IndexOf('"') >= 0) return false;
        string[] components = id.Split('\\');
        if (components.Length != 3 || Array.Exists(components, string.IsNullOrWhiteSpace)) return false;
        foreach (char character in id)
            if (char.IsControl(character)) return false;
        return true;
    }

    public static object List()
    {
        var devices = new List<object>();
        foreach (Device device in PresentDevices())
        {
            string name = ReadString(device.Instance, FriendlyName) ?? ReadString(device.Instance, DeviceDescription) ?? device.Id;
            devices.Add(new { id = device.Id, name, status = device.Status });
        }
        return new { devices };
    }

    public static Result Request(string id, bool enable)
    {
        Device target = Find(id);
        if (target == null || target.Status == Unavailable) return new Result(false, Unavailable, "unavailable");
        string desired = enable ? Enabled : Disabled;
        if (target.Status == desired) return new Result(false, target.Status);

        // Only the single validated operation crosses the UAC boundary.
        var start = new ProcessStartInfo(typeof(CameraControl).Assembly.Location)
        {
            Arguments = "camera --set \"" + target.Id + "\" " + (enable ? "enable" : "disable"),
            Verb = "runas",
            UseShellExecute = true,
            WorkingDirectory = Environment.SystemDirectory,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        int exitCode;
        try
        {
            using (Process child = Process.Start(start))
            {
                if (child == null) return new Result(false, FindStatus(target.Id), "failed");
                child.WaitForExit();
                exitCode = child.ExitCode;
            }
        }
        catch (Win32Exception error)
        {
            return new Result(false, FindStatus(target.Id), error.NativeErrorCode == UserCancelled ? "cancelled" : "failed");
        }

        string status = FindStatus(target.Id);
        if (exitCode == 0 && status == desired) return new Result(true, status);
        return new Result(false, status, status == Unavailable ? "unavailable" : "failed");
    }

    public static Result Set(string id, bool enable)
    {
        Device target = Find(id);
        if (target == null || target.Status == Unavailable) return new Result(false, Unavailable, "unavailable");
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                return new Result(false, target.Status, "failed");

        string desired = enable ? Enabled : Disabled;
        if (target.Status == desired) return new Result(false, target.Status);
        uint result = enable
            ? CM_Enable_DevNode(target.Instance, 0)
            : CM_Disable_DevNode(target.Instance, DisablePersistently | SuppressDisableFailureUi);
        if (result != Success) return new Result(false, FindStatus(target.Id), "failed");

        var clock = Stopwatch.StartNew();
        string status = FindStatus(target.Id);
        while (status != desired && clock.ElapsedMilliseconds < 5000)
        {
            Thread.Sleep(125);
            status = FindStatus(target.Id);
        }
        return status == desired ? new Result(true, status) : new Result(false, status, "failed");
    }

    private static Device Find(string id)
    {
        foreach (Device device in PresentDevices())
            if (string.Equals(id, device.Id, StringComparison.OrdinalIgnoreCase)) return device;
        return null;
    }

    private static string FindStatus(string id)
    {
        Device target = Find(id);
        return target == null ? Unavailable : target.Status;
    }

    private static IEnumerable<Device> PresentDevices()
    {
        foreach (string id in ReadPresentIds())
        {
            uint device, flags, problem;
            if (!ValidId(id) || !IsPhysicalCameraId(id) ||
                CM_Locate_DevNodeW(out device, id, 0) != Success ||
                CM_Get_DevNode_Status(out flags, out problem, device, 0) != Success) continue;
            yield return new Device(id, device, Classify(id, device, flags, problem));
        }
    }

    private static bool IsPhysicalCameraId(string id)
    {
        // USB cameras use a vendor ID. Integrated cameras are enumerated by their hardware bus.
        return id.StartsWith("USB\\VID_", StringComparison.OrdinalIgnoreCase) ||
            id.StartsWith("ACPI\\", StringComparison.OrdinalIgnoreCase) ||
            id.StartsWith("PCI\\", StringComparison.OrdinalIgnoreCase) ||
            id.StartsWith("I2C\\", StringComparison.OrdinalIgnoreCase) ||
            id.StartsWith("SPI\\", StringComparison.OrdinalIgnoreCase) ||
            id.StartsWith("MIPI\\", StringComparison.OrdinalIgnoreCase);
    }

    private static string Classify(string id, uint device, uint flags, uint problem)
    {
        // Only leaf nodes are safe to change. A composite webcam can expose a sibling microphone.
        uint child;
        if (CM_Get_Child(out child, device, 0) != NoSuchDevNode) return Unavailable;
        Guid audioClass = AudioInterface;
        uint audioInterfacesLength;
        if (CM_Get_Device_Interface_List_SizeW(out audioInterfacesLength, ref audioClass, id, IncludeDisabledInterfaces) != Success ||
            audioInterfacesLength > 2) return Unavailable;
        if ((flags & HasProblem) != 0) return problem == ProblemDisabled ? Disabled : Unavailable;
        return (flags & (Started | Disableable)) == (Started | Disableable) ? Enabled : Unavailable;
    }

    private static string[] ReadPresentIds()
    {
        // Plugging a camera in between sizing and filling the buffer can require a retry.
        for (int attempt = 0; attempt < 3; attempt++)
        {
            uint length;
            if (CM_Get_Device_ID_List_SizeW(out length, CameraClass, PresentCameraClass) != Success) break;
            var buffer = new byte[checked((int)length * 2)];
            uint result = CM_Get_Device_ID_ListW(CameraClass, buffer, length, PresentCameraClass);
            if (result == Success) return Encoding.Unicode.GetString(buffer).Split(new[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
            if (result != BufferSmall) break;
        }
        throw new InvalidOperationException("Windows camera device enumeration failed.");
    }

    private static string ReadString(uint device, uint property)
    {
        var buffer = new byte[2048];
        uint length = (uint)buffer.Length;
        uint type;
        if (CM_Get_DevNode_Registry_PropertyW(device, property, out type, buffer, ref length, 0) != Success ||
            type != RegistryString || length > buffer.Length) return null;
        string value = Encoding.Unicode.GetString(buffer, 0, (int)length).TrimEnd('\0');
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport(CfgMgr, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint CM_Get_Device_ID_List_SizeW(out uint length, string filter, uint flags);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport(CfgMgr, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint CM_Get_Device_ID_ListW(string filter, [Out] byte[] buffer, uint length, uint flags);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport(CfgMgr, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint CM_Locate_DevNodeW(out uint device, string id, uint flags);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport(CfgMgr, ExactSpelling = true)]
    private static extern uint CM_Get_DevNode_Status(out uint status, out uint problem, uint device, uint flags);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport(CfgMgr, ExactSpelling = true)]
    private static extern uint CM_Get_Child(out uint child, uint device, uint flags);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport(CfgMgr, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint CM_Get_Device_Interface_List_SizeW(out uint length, ref Guid interfaceClass, string id, uint flags);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport(CfgMgr, ExactSpelling = true)]
    private static extern uint CM_Get_DevNode_Registry_PropertyW(uint device, uint property, out uint type, [Out] byte[] buffer, ref uint length, uint flags);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport(CfgMgr, ExactSpelling = true)]
    private static extern uint CM_Enable_DevNode(uint device, uint flags);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport(CfgMgr, ExactSpelling = true)]
    private static extern uint CM_Disable_DevNode(uint device, uint flags);
}
