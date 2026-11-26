using System;
using System.Runtime.InteropServices;

internal sealed class Microphone : IDisposable
{
    private const uint LocalCom = 5;
    private const uint NoPersist = 0x00080000;
    private readonly bool openMeterStream;
    private IMMDeviceEnumerator enumerator;
    private IMMDevice endpoint;
    private string endpointId;
    private IAudioMeterInformation meter;
    private IAudioEndpointVolume volume;
    private IAudioClient client;
    private IAudioCaptureClient capture;

    public Microphone(bool openMeterStream)
    {
        this.openMeterStream = openMeterStream;
    }

    public void Refresh()
    {
        IMMDevice candidate = null;
        try
        {
            if (enumerator == null) enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            Check(enumerator.GetDefaultAudioEndpoint(1, 0, out candidate));
            string id;
            Check(candidate.GetId(out id));
            if (StringComparer.Ordinal.Equals(id, endpointId) && volume != null) return;
            CloseEndpoint();
            endpoint = candidate;
            candidate = null;
            endpointId = id;
            volume = Activate<IAudioEndpointVolume>();
            meter = Activate<IAudioMeterInformation>();
            if (openMeterStream) StartMeterStream();
        }
        catch (COMException) { CloseEndpoint(); }
        finally { Release(candidate); }
    }

    public void Toggle()
    {
        if (volume == null) return;
        try
        {
            bool mute;
            Check(volume.GetMute(out mute));
            Check(volume.SetMute(!mute, IntPtr.Zero));
        }
        catch (COMException) { CloseEndpoint(); }
    }

    public object Sample()
    {
        if (volume == null || meter == null) return null;
        try
        {
            DrainMeterStream();
            bool mute;
            float peak;
            Check(volume.GetMute(out mute));
            Check(meter.GetPeakValue(out peak));
            double? db = !mute && peak > 0.001f ? (double?)Math.Round(20 * Math.Log10(Math.Min(peak, 1))) : null;
            return new { db, muted = mute };
        }
        catch (COMException)
        {
            CloseEndpoint();
            return null;
        }
    }

    private void StartMeterStream()
    {
        IntPtr format = IntPtr.Zero;
        try
        {
            client = Activate<IAudioClient>();
            Check(client.GetMixFormat(out format));
            Check(client.Initialize(0, NoPersist, 2500000, 0, format, IntPtr.Zero));
            Guid id = typeof(IAudioCaptureClient).GUID;
            object service;
            Check(client.GetService(ref id, out service));
            capture = (IAudioCaptureClient)service;
            Check(client.Start());
        }
        catch (COMException)
        {
            // The endpoint's meter can still work if a separate app owns the capture stream.
            CloseMeterStream();
        }
        finally
        {
            if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
        }
    }

    private void DrainMeterStream()
    {
        if (capture == null) return;
        uint size;
        Check(capture.GetNextPacketSize(out size));
        while (size != 0)
        {
            IntPtr samples;
            uint frames, flags;
            Check(capture.GetBuffer(out samples, out frames, out flags, IntPtr.Zero, IntPtr.Zero));
            // Release each packet without reading or copying any audio samples.
            Check(capture.ReleaseBuffer(frames));
            Check(capture.GetNextPacketSize(out size));
        }
    }

    private T Activate<T>() where T : class
    {
        Guid id = typeof(T).GUID;
        object clientObject;
        Check(endpoint.Activate(ref id, LocalCom, IntPtr.Zero, out clientObject));
        return (T)clientObject;
    }

    private static void Check(int result)
    {
        if (result < 0) Marshal.ThrowExceptionForHR(result);
    }

    private static void Release(object instance)
    {
        if (instance != null && Marshal.IsComObject(instance)) Marshal.ReleaseComObject(instance);
    }

    private void CloseMeterStream()
    {
        if (client != null) client.Stop();
        Release(capture);
        Release(client);
        capture = null;
        client = null;
    }

    private void CloseEndpoint()
    {
        CloseMeterStream();
        Release(volume);
        Release(meter);
        Release(endpoint);
        volume = null;
        meter = null;
        endpoint = null;
        endpointId = null;
    }

    public void Dispose()
    {
        CloseEndpoint();
        Release(enumerator);
        enumerator = null;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid id, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float value);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr callback);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr callback);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float level, IntPtr context);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, IntPtr context);
        [PreserveSig] int GetMasterVolumeLevel(out float level);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, IntPtr context);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, IntPtr context);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int mode, uint flags, long buffer, long periodicity, IntPtr format, IntPtr session);
        [PreserveSig] int GetBufferSize(out uint size);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr format, IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid id, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr samples, out uint frames, out uint flags, IntPtr position, IntPtr time);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }
}
