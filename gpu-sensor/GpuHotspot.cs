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
        bool extended = args.Length == 1 && (args[0] == "--telemetry" || args[0] == "--telemetry-once");
        single |= extended && args[0] == "--telemetry-once";
        if (!single && !extended && args.Length != 0) return 1;

        var computer = new Computer { IsGpuEnabled = true };
        try
        {
            computer.Open();
            IHardware gpu = computer.Hardware.FirstOrDefault(device => device.HardwareType == HardwareType.GpuNvidia);
            if (gpu == null)
            {
                Console.WriteLine(extended ? "{}" : "null");
                return 0;
            }

            do
            {
                gpu.Update();
                var sensor = gpu.Sensors.FirstOrDefault(item =>
                    item.SensorType == SensorType.Temperature && item.Name == "GPU Hot Spot");
                float? value = sensor == null ? null : sensor.Value;
                string hotspot = value.HasValue && value.Value > 0 && value.Value <= 150
                    ? Number(value) : "null";
                if (extended)
                {
                    float? fanRpm = gpu.Sensors.Where(item => item.SensorType == SensorType.Fan &&
                        item.Value.HasValue && item.Value.Value >= 0 && !float.IsInfinity(item.Value.Value))
                        .Select(item => item.Value).Max();
                    Console.WriteLine("{{\"gpuHotspot\":{0},\"gpuFanRpm\":{1}}}", hotspot, Number(fanRpm));
                }
                else
                {
                    Console.WriteLine(hotspot);
                }
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

    private static string Number(float? value)
    {
        return value.HasValue ? value.Value.ToString("0.0", CultureInfo.InvariantCulture) : "null";
    }
}
