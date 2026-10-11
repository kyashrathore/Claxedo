import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { compiledProgramCommand, powershellPath } from "@claxedo/helpers/windows-powershell"
import { harnessSpawnEnv } from "../spawn-env"
import type { CreationIdentity } from "./identity"
import { createLineHelper, type HelperAnswer } from "./line-helper"

const SOURCE_VARIABLE = "CLAXEDO_WINDOWS_JOB_SOURCE"

/**
 * `contain <pid> <creation time>` puts that process in a new job and answers
 * `contained`, `absent` for a process that is gone, `mismatch <creation time>`
 * for a pid another process now holds, or `error <reason>`.
 *
 * The job ends every process in it when its last handle closes, and the only
 * handle left once this answers is the one duplicated into the contained
 * process: the job lives exactly as long as that process, and its end — by
 * retirement or on its own — ends everything it started, an orphan whose
 * parent already exited included. That copy is not inheritable, or a child
 * holding it would keep the job alive past its leader. A duplicate that fails
 * closes this program's handle with the process already inside, which ends it.
 *
 * The job allows no breakaway. libuv puts each non-detached child in a job of
 * its own that does, but a child breaks away only up to the first job in its
 * chain that refuses, so a contained process's descendants stay here however
 * they are spawned.
 *
 * WMI reports creation times to the microsecond and `GetProcessTimes` to
 * 100 ns, so the identity check compares within 10 ticks.
 */
export const WINDOWS_JOB_SOURCE = `
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;

public static class ClaxedoJob
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private const uint ProcessTerminate = 0x0001;
    private const uint ProcessDupHandle = 0x0040;
    private const uint ProcessSetQuota = 0x0100;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const int ExtendedLimitInformation = 9;
    private const uint KillOnJobClose = 0x2000;
    private const uint DuplicateSameAccess = 0x2;
    private const int ErrorInvalidParameter = 87;
    private const long CreationToleranceTicks = 10;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static void Serve()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string answer;
            try
            {
                answer = Answer(line);
            }
            catch (Exception reason)
            {
                answer = "error " + Describe(reason);
            }
            Console.Out.WriteLine(answer);
            Console.Out.Flush();
        }
    }

    private static string Answer(string line)
    {
        string[] words = line.Split(' ');
        if (words.Length != 3 || words[0] != "contain") throw new ArgumentException("not a request this program serves");
        int pid = int.Parse(words[1], NumberStyles.None, CultureInfo.InvariantCulture);
        long created = DateTime.Parse(words[2], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToFileTimeUtc();
        return Contain(pid, created);
    }

    private static string Contain(int pid, long created)
    {
        IntPtr process = OpenProcess(ProcessTerminate | ProcessDupHandle | ProcessSetQuota | ProcessQueryLimitedInformation | Synchronize, false, pid);
        if (process == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == ErrorInvalidParameter) return "absent";
            throw new Win32Exception(error, "the process could not be opened");
        }
        try
        {
            if (Exited(process)) return "absent";
            long creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "the process's creation time could not be read");
            }
            if (Math.Abs(creation - created) >= CreationToleranceTicks)
            {
                return "mismatch " + DateTime.FromFileTimeUtc(creation).ToString("o", CultureInfo.InvariantCulture);
            }
            IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "the job could not be created");
            try
            {
                ExtendedLimits limits = new ExtendedLimits();
                limits.Basic.LimitFlags = KillOnJobClose;
                if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "the job could not be set to end its processes when it closes");
                }
                if (!AssignProcessToJobObject(job, process))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (Exited(process)) return "absent";
                    throw new Win32Exception(error, "the process could not be put in the job");
                }
                IntPtr held;
                if (!DuplicateHandle(GetCurrentProcess(), job, process, out held, 0, false, DuplicateSameAccess))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (Exited(process)) return "absent";
                    throw new Win32Exception(error, "the process could not be given the job's handle");
                }
                return "contained";
            }
            finally
            {
                CloseHandle(job);
            }
        }
        finally
        {
            CloseHandle(process);
        }
    }

    private static bool Exited(IntPtr process)
    {
        return WaitForSingleObject(process, 0) == 0;
    }

    private static string Describe(Exception reason)
    {
        string message = reason.Message;
        Win32Exception native = reason as Win32Exception;
        if (native != null) message += " (Windows error " + native.NativeErrorCode + ")";
        return message.Replace('\\r', ' ').Replace('\\n', ' ');
    }
}
`

export const WINDOWS_JOB_COMMAND = compiledProgramCommand(SOURCE_VARIABLE, "ClaxedoJob")

export type WindowsJobsOptions = {
  launch: () => ChildProcessWithoutNullStreams
}

/** `exited` is a process that ended before it could be contained, which leaves nothing running to contain. */
export type JobContainment = "contained" | "exited"

/**
 * Puts processes in jobs through one long-lived PowerShell, which compiles its
 * program once: a contained launch costs one line each way after that.
 */
export function createWindowsJobs(options: WindowsJobsOptions) {
  const helper = createLineHelper({ name: "job helper", launch: options.launch })
  return {
    warm: () => helper.warm(),
    contain: (identity: Pick<CreationIdentity, "pid" | "startSecond">, timeoutMs: number) =>
      helper.ask(`contain ${identity.pid} ${identity.startSecond}`, `pid ${identity.pid}`, timeoutMs, (line) => containment(identity.pid, line)),
  }
}

function containment(pid: number, line: string): HelperAnswer<JobContainment> {
  if (line === "contained") return { value: "contained" }
  if (line === "absent") return { value: "exited" }
  if (line.startsWith("mismatch ")) return { refusal: `pid ${pid} is now a process created at ${line.slice("mismatch ".length)}, not the recorded launch` }
  if (line.startsWith("error ")) return { refusal: line.slice("error ".length) }
  return undefined
}

/** The first request includes PowerShell's start and the program's compile. */
const CONTAIN_TIMEOUT_MS = 30_000

const windowsJobs = createWindowsJobs({
  launch: () => spawn(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_JOB_COMMAND], {
    env: { ...harnessSpawnEnv(process.env), [SOURCE_VARIABLE]: WINDOWS_JOB_SOURCE },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }),
})

/**
 * Contains a live Windows process this host verified and everything it will
 * start in a job that ends with it. Throws when it cannot: a launch that runs
 * uncontained is one retirement cannot finish.
 */
export function containInWindowsJob(identity: CreationIdentity): Promise<JobContainment> {
  return windowsJobs.contain(identity, CONTAIN_TIMEOUT_MS)
}

/**
 * Starts the job helper while a launch is still spawning. Its first start and
 * compile took 350-430 ms on an m7i.2xlarge, which the spawn, pid and
 * identity reads before containment then cover.
 */
export function warmWindowsJobs() {
  windowsJobs.warm()
}
