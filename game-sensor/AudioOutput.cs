using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

internal sealed class AudioOutput : IDisposable
{
    private const uint Active = 1;
    private const uint LocalCom = 5;
    private const int NotFound = unchecked((int)0x80070490);
    private static readonly PropertyKey FriendlyName = new PropertyKey
    {
        Format = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
        Id = 14
    };
    private readonly IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();

    public object List()
    {
        var devices = new List<object>();
        foreach (var endpoint in ActiveEndpoints())
        {
            string id = GetId(endpoint);
            devices.Add(new { id, name = GetName(endpoint) ?? id });
        }
        IMMDevice active = GetDefaultEndpoint(AudioRole.Multimedia);
        try
        {
            return new
            {
                devices,
                activeId = active == null ? null : GetId(active),
                volumePercent = GetVolumePercent(active)
            };
        }
        finally { Release(active); }
    }

    public bool Switch(string id)
    {
        foreach (var endpoint in ActiveEndpoints())
        {
            if (GetId(endpoint) != id) continue;
            string console = GetDefault(AudioRole.Console);
            string multimedia = GetDefault(AudioRole.Multimedia);
            if (id == console && id == multimedia) return true;

            var policy = (IPolicyConfig)new PolicyConfigClient();
            try
            {
                if (id != console) Check(policy.SetDefaultEndpoint(id, AudioRole.Console));
                if (id != multimedia)
                {
                    int result = policy.SetDefaultEndpoint(id, AudioRole.Multimedia);
                    if (result < 0 && id != console && console != null && GetDefault(AudioRole.Console) == id)
                        policy.SetDefaultEndpoint(console, AudioRole.Console);
                    Check(result);
                }
                return true;
            }
            finally { Release(policy); }
        }
        return false;
    }

    private IEnumerable<IMMDevice> ActiveEndpoints()
    {
        IMMDeviceCollection endpoints = null;
        try
        {
            Check(enumerator.EnumAudioEndpoints(AudioFlow.Render, Active, out endpoints));
            uint count;
            Check(endpoints.GetCount(out count));
            for (uint index = 0; index < count; index++)
            {
                IMMDevice endpoint = null;
                try
                {
                    Check(endpoints.Item(index, out endpoint));
                    yield return endpoint;
                }
                finally { Release(endpoint); }
            }
        }
        finally { Release(endpoints); }
    }

    private string GetDefault(AudioRole role)
    {
        IMMDevice endpoint = GetDefaultEndpoint(role);
        try { return endpoint == null ? null : GetId(endpoint); }
        finally { Release(endpoint); }
    }

    private IMMDevice GetDefaultEndpoint(AudioRole role)
    {
        IMMDevice endpoint;
        int result = enumerator.GetDefaultAudioEndpoint(AudioFlow.Render, role, out endpoint);
        if (result >= 0) return endpoint;
        Release(endpoint);
        if (result != NotFound) Check(result);
        return null;
    }

    private static int? GetVolumePercent(IMMDevice endpoint)
    {
        if (endpoint == null) return null;
        Guid interfaceId = typeof(IAudioEndpointVolume).GUID;
        object instance = null;
        try
        {
            if (endpoint.Activate(ref interfaceId, LocalCom, IntPtr.Zero, out instance) < 0) return null;
            var volume = instance as IAudioEndpointVolume;
            float scalar;
            if (volume == null || volume.GetMasterVolumeLevelScalar(out scalar) < 0 ||
                float.IsNaN(scalar) || float.IsInfinity(scalar)) return null;
            return (int)Math.Round(Math.Max(0, Math.Min(1, scalar)) * 100);
        }
        finally { Release(instance); }
    }

    private static string GetId(IMMDevice endpoint)
    {
        string id;
        Check(endpoint.GetId(out id));
        return id;
    }

    private static string GetName(IMMDevice endpoint)
    {
        var key = FriendlyName;
        IPropertyStore store = null;
        PropVariant value = new PropVariant();
        try
        {
            if (endpoint.OpenPropertyStore(0, out store) < 0) return null;
            if (store.GetValue(ref key, out value) < 0 || value.Type != (ushort)VarEnum.VT_LPWSTR) return null;
            string name = Marshal.PtrToStringUni(value.Pointer);
            return string.IsNullOrWhiteSpace(name) ? null : name;
        }
        finally
        {
            PropVariantClear(ref value);
            Release(store);
        }
    }

    public void Dispose()
    {
        Release(enumerator);
    }

    private static void Check(int result)
    {
        if (result < 0) throw new COMException("Windows Core Audio call failed.", result);
    }

    private static void Release(object instance)
    {
        if (instance != null) Marshal.ReleaseComObject(instance);
    }

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    private class PolicyConfigClient { }

    // Windows 11's audio policy interface. The unused slots precede SetDefaultEndpoint in its vtable.
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat();
        [PreserveSig] int GetDeviceFormat();
        [PreserveSig] int ResetDeviceFormat();
        [PreserveSig] int SetDeviceFormat();
        [PreserveSig] int GetProcessingPeriod();
        [PreserveSig] int SetProcessingPeriod();
        [PreserveSig] int GetShareMode();
        [PreserveSig] int SetShareMode();
        [PreserveSig] int GetPropertyValue();
        [PreserveSig] int SetPropertyValue();
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, AudioRole role);
    }
}
