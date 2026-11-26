using System;
using System.Globalization;
using System.Linq;
using System.Threading;
using LibreHardwareMonitor.Hardware;

internal static class GpuHotspot
{
    private const int SampleIntervalMs = 1000;

    private static int Main(string[] args)
    {
        bool single = args.Length == 1 && args[0] == "--once";
        if (!single && args.Length != 0) return 1;

        var computer = new Computer { IsGpuEnabled = true };
        try
        {
            computer.Open();
            IHardware gpu = computer.Hardware.FirstOrDefault(device => device.HardwareType == HardwareType.GpuNvidia);
            if (gpu == null)
            {
                Console.WriteLine("null");
                return 0;
            }

            do
            {
                gpu.Update();
                var sensor = gpu.Sensors.FirstOrDefault(item =>
                    item.SensorType == SensorType.Temperature && item.Name == "GPU Hot Spot");
                float? value = sensor == null ? null : sensor.Value;
                Console.WriteLine(value.HasValue && value.Value > 0 && value.Value <= 150
                    ? value.Value.ToString("0.0", CultureInfo.InvariantCulture)
                    : "null");
                if (!single) Thread.Sleep(SampleIntervalMs);
            } while (!single);
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine("NVIDIA GPU Hot Spot unavailable: {0}", exception.GetType().Name);
            return 2;
        }
        finally
        {
            computer.Close();
        }
    }
}
