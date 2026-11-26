using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using LibreHardwareMonitor.Hardware;

internal static class CpuSensor
{
    private const int SampleIntervalMs = 2000;
    private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--once")
        {
            using (var sensor = new TemperatureSensor())
            {
                Console.OutputEncoding = new UTF8Encoding(false);
                Console.WriteLine(sensor.ReadJson());
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
                    Publish(snapshotPath, sensor.ReadJson());
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
        private DateTime nextFanTry = DateTime.MinValue;

        public string ReadJson()
        {
            float? temperature = ReadTemperature();
            return Serializer.Serialize(new
            {
                cpuTemperature = temperature,
                fans = ReadFans(),
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            });
        }

        private float? ReadTemperature()
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

        private List<object> ReadFans()
        {
            var fans = new List<object>();
            if (computer == null || DateTime.UtcNow < nextFanTry)
                return fans;

            try
            {
                if (!computer.IsMotherboardEnabled)
                    computer.IsMotherboardEnabled = true;
                foreach (IHardware board in computer.Hardware.Where(h => h.HardwareType == HardwareType.Motherboard))
                    AddFans(board, fans);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Motherboard fans unavailable ({0}).", ex.GetType().Name);
                nextFanTry = DateTime.UtcNow.AddSeconds(30);
            }
            return fans;
        }

        private static void AddFans(IHardware hardware, List<object> fans)
        {
            hardware.Update();
            foreach (ISensor sensor in hardware.Sensors.Where(item => item.SensorType == SensorType.Fan))
            {
                float? rpm = sensor.Value;
                if (rpm.HasValue && rpm.Value >= 0 && !float.IsInfinity(rpm.Value))
                    fans.Add(new { id = sensor.Identifier.ToString(), name = sensor.Name, reading = rpm.Value, unit = "rpm" });
            }
            foreach (IHardware child in hardware.SubHardware)
                AddFans(child, fans);
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
