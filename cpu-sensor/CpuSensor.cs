using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using LibreHardwareMonitor.Hardware;

internal static class CpuSensor
{
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private const int SampleIntervalMs = 2000;

    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--once")
        {
            using (var sensor = new TemperatureSensor())
            {
                Console.WriteLine(SampleJson(sensor.Read()));
                return 0;
            }
        }

        string snapshotPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Auskraft", "AjazzTTX", "cpu-temperature.json");
        if (args.Length != 2 || args[0] != "--publish" ||
            !string.Equals(args[1], snapshotPath, StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("Usage: CpuSensor.exe --once");
            return 2;
        }

        try
        {
            using (var sensor = new TemperatureSensor())
            {
                while (true)
                {
                    Publish(snapshotPath, SampleJson(sensor.Read()));
                    Thread.Sleep(SampleIntervalMs);
                }
            }
        }
        catch (UnauthorizedAccessException)
        {
            Console.Error.WriteLine("The sensor task cannot write to its installation directory.");
            return 3;
        }
        catch (IOException)
        {
            Console.Error.WriteLine("The sensor task cannot update its local readings.");
            return 4;
        }
    }

    private static string SampleJson(float? temperature)
    {
        string value = temperature.HasValue ? temperature.Value.ToString("0.0", Invariant) : "null";
        long timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return "{\"cpuTemperature\":" + value + ",\"timestamp\":" + timestamp.ToString(Invariant) + "}";
    }

    private static void Publish(string destination, string json)
    {
        string temporary = destination + ".tmp";
        File.WriteAllText(temporary, json, new UTF8Encoding(false));
        if (File.Exists(destination))
            File.Replace(temporary, destination, null);
        else
            File.Move(temporary, destination);
    }

    private sealed class TemperatureSensor : IDisposable
    {
        private static readonly string[] SensorNames =
        {
            "Core (Tdie)",
            "Core (Tctl/Tdie)",
            "CPU Package",
            "CPU (Tctl/Tdie)",
            "Core (Tctl)",
            "CPU Package Temperature"
        };

        private Computer computer;
        private DateTime nextTry = DateTime.MinValue;

        public float? Read()
        {
            try
            {
                if (computer == null)
                {
                    if (DateTime.UtcNow < nextTry)
                        return null;

                    computer = new Computer { IsCpuEnabled = true };
                    computer.Open();
                }

                var cpus = computer.Hardware.Where(hardware => hardware.HardwareType == HardwareType.Cpu);
                foreach (IHardware cpu in cpus)
                {
                    cpu.Update();
                    foreach (string name in SensorNames)
                    {
                        var sensor = cpu.Sensors.FirstOrDefault(item => item.SensorType == SensorType.Temperature &&
                            string.Equals(item.Name, name, StringComparison.OrdinalIgnoreCase));
                        float? value = sensor == null ? null : sensor.Value;
                        if (value.HasValue && value.Value > 0 && value.Value <= 125)
                            return value;
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("CPU thermal sensor unavailable ({0}).", ex.GetType().Name);
                Dispose();
                nextTry = DateTime.UtcNow.AddSeconds(30);
            }

            return null;
        }

        public void Dispose()
        {
            if (computer == null)
                return;

            try { computer.Close(); }
            catch (Exception ex) { Console.Error.WriteLine("CPU sensor cleanup failed ({0}).", ex.GetType().Name); }
            computer = null;
        }
    }
}
