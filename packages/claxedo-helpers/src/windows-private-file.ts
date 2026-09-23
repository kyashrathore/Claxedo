import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { join } from "node:path"

/**
 * Creating a private file on Windows.
 *
 * Windows has no POSIX mode: `open`'s `mode` only toggles the read-only
 * attribute, `chmod` cannot narrow a DACL, and `stat().mode` reports a
 * synthesized 0o666 that never reflects one. A file's protection is its
 * security descriptor, and a secret under a parent that grants `Users` read is
 * readable by every local account.
 *
 * Applying the descriptor after the file exists does not fix that. Windows
 * checks access when a handle is opened and never again, so a handle opened
 * while the file was still broad keeps reading it after the descriptor
 * narrows — the secret is written into a file someone already holds. Resolving
 * the name a second time is the other half: between the create and the apply,
 * the name can be moved aside and a decoy left in its place, which is what then
 * gets the descriptor, the verification, and the publish.
 *
 * So the descriptor exists at creation, the staging file is opened with no
 * sharing at all, and its name is never resolved again: it is filled through
 * that first handle and published through it too. Node does not open the file
 * on this platform; this module owns its whole life.
 *
 * Cleanup is armed on that same handle rather than performed afterwards.
 * Delete-on-close cannot be used, because it is the one disposition
 * `FILE_DISPOSITION_INFO` cannot later clear, and clearing it is exactly what
 * publishing requires. So the classic disposition is set the moment the file
 * exists and cleared before the rename. What that buys, and what it does not,
 * is written out at {@link writeWindowsPrivateFile}.
 */

/** Thrown instead of returning: a file that cannot be made private must not receive secret bytes. */
export class PrivateFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PrivateFileError"
  }
}

const STAGING_VARIABLE = "CLAXEDO_PRIVATE_FILE_STAGING"
const TARGET_VARIABLE = "CLAXEDO_PRIVATE_FILE_TARGET"
const SOURCE_VARIABLE = "CLAXEDO_PRIVATE_FILE_SOURCE"

/**
 * Length-framed, so the end of the pipe is never mistaken for the end of the
 * secret. A closed stdin, a killed writer and a half-delivered payload all
 * reach the runner as "do not publish" instead of as an empty or truncated
 * credential file — which is what an unframed `CopyTo` would have published.
 */
const FRAME_MAGIC = "CLXD1"
const FRAME_HEADER_BYTES = FRAME_MAGIC.length + 1 + 8
const COMMIT = 1
const ABORT = 0

function payloadFrame(verb: number, length: number) {
  const header = Buffer.alloc(FRAME_HEADER_BYTES)
  header.write(FRAME_MAGIC, 0, "ascii")
  header.writeUInt8(verb, FRAME_MAGIC.length)
  header.writeBigUInt64LE(BigInt(length), FRAME_MAGIC.length + 1)
  return header
}

/**
 * `FILE_RENAME_INFO` is laid out by hand because it is variable-length. Offsets
 * come from the pointer size: a `BOOLEAN`, padding to the `HANDLE`, the
 * `HANDLE`, then the `DWORD` length.
 *
 * `dwShareMode` 0 is the line that matters most. It is what makes the window
 * unreachable rather than narrow, and it holds whatever share mask the calling
 * runtime would have chosen — libuv always adds `FILE_SHARE_DELETE`, and this
 * file is never opened by libuv.
 */
const RUNNER_SOURCE = `
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class ClaxedoPrivateFile
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        public int InheritHandle;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
        ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass,
        IntPtr info, int size);

    private const uint GenericWrite = 0x40000000;
    private const uint Delete = 0x00010000;
    private const uint ReadControl = 0x00020000;
    private const uint CreateNew = 1;
    private const uint Normal = 0x00000080;
    private const uint OpenReparsePoint = 0x00200000;
    private const int RenameInfo = 3;
    private const int DispositionInfo = 4;
    private const int RenameRetryMs = 2000;
    private const int RenamePollMs = 25;
    private const int HeaderBytes = 14;

    public static void Run(string staging, string target)
    {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        RawSecurityDescriptor wanted = new RawSecurityDescriptor(
            "O:" + sid + "G:" + sid + "D:P(A;;FA;;;" + sid + ")");
        byte[] blob = new byte[wanted.BinaryLength];
        wanted.GetBinaryForm(blob, 0);
        GCHandle pinned = GCHandle.Alloc(blob, GCHandleType.Pinned);
        SafeFileHandle handle;
        try
        {
            SecurityAttributes security = new SecurityAttributes();
            security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            security.Descriptor = pinned.AddrOfPinnedObject();
            security.InheritHandle = 0;
            handle = CreateFileW(staging, GenericWrite | Delete | ReadControl, 0, ref security,
                CreateNew, Normal | OpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "the staging file could not be created");
            }
        }
        finally
        {
            pinned.Free();
        }

        FileStream file = new FileStream(handle, FileAccess.Write);
        bool published = false;
        try
        {
            // Armed before the caller is told the file exists, so every path out
            // of here from now on — including one that never runs another line
            // of this method — takes the staging file with it.
            Arm(handle, true);
            Console.Out.WriteLine("READY " + Verify(file, sid));
            Console.Out.Flush();
            // Throwing rather than returning: a run that did not publish must
            // not exit zero, or the caller reads "the credential was written"
            // off a process that wrote nothing.
            if (!Fill(file)) throw new Exception(Cancelled ? "the caller cancelled the write"
                : "the caller closed the connection before sending the whole payload");
            file.Flush(true);
            Arm(handle, false);
            Rename(handle, target);
            published = true;
            Console.Out.WriteLine("PUBLISHED");
            Console.Out.Flush();
        }
        finally
        {
            if (!published) Arm(handle, true);
            file.Dispose();
        }
    }

    // Reads the frame and returns whether the caller asked for a publication.
    // Anything short of the whole payload is a refusal, never a short write.
    private static bool Cancelled = false;

    private static bool Fill(FileStream file)
    {
        Stream input = Console.OpenStandardInput();
        byte[] header = new byte[HeaderBytes];
        if (!ReadExactly(input, header, HeaderBytes)) return false;
        if (System.Text.Encoding.ASCII.GetString(header, 0, 5) != "CLXD1")
        {
            throw new Exception("the caller sent an unrecognised frame");
        }
        if (header[5] != 1) { Cancelled = true; return false; }
        long length = BitConverter.ToInt64(header, 6);
        if (length < 0) throw new Exception("the caller sent a negative length");
        byte[] buffer = new byte[65536];
        long remaining = length;
        while (remaining > 0)
        {
            int wanted = (int)Math.Min(remaining, buffer.Length);
            if (!ReadExactly(input, buffer, wanted)) return false;
            file.Write(buffer, 0, wanted);
            remaining -= wanted;
        }
        return true;
    }

    private static bool ReadExactly(Stream input, byte[] buffer, int count)
    {
        int filled = 0;
        while (filled < count)
        {
            int read = input.Read(buffer, filled, count - filled);
            if (read <= 0) return false;
            filled += read;
        }
        return true;
    }

    // Read back through the handle, never through the name, and rendered for the caller to assert on.
    private static string Verify(FileStream file, string sid)
    {
        FileSecurity actual = file.GetAccessControl();
        if (!actual.AreAccessRulesProtected) throw new Exception("inherited permissions still apply");
        AuthorizationRuleCollection rules =
            actual.GetAccessRules(true, true, typeof(SecurityIdentifier));
        if (rules.Count != 1) throw new Exception("expected one permission entry, found " + rules.Count);
        FileSystemAccessRule rule = (FileSystemAccessRule)rules[0];
        if (rule.AccessControlType != AccessControlType.Allow) throw new Exception("the entry is not an allow");
        if (((SecurityIdentifier)rule.IdentityReference).Value != sid)
        {
            throw new Exception("unexpected trustee " + rule.IdentityReference.Value);
        }
        if (rule.FileSystemRights != FileSystemRights.FullControl)
        {
            throw new Exception("unexpected rights " + rule.FileSystemRights);
        }
        string owner = ((SecurityIdentifier)actual.GetOwner(typeof(SecurityIdentifier))).Value;
        if (owner != sid) throw new Exception("unexpected owner " + owner);
        return actual.GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner);
    }

    // The classic disposition, which unlike FILE_FLAG_DELETE_ON_CLOSE can be
    // cleared again — and clearing it is what publishing requires. Failing to
    // arm is fatal: proceeding would mean a crash leaves the secret staged.
    private static void Arm(SafeFileHandle handle, bool armed)
    {
        IntPtr info = Marshal.AllocHGlobal(1);
        try
        {
            Marshal.WriteByte(info, 0, armed ? (byte)1 : (byte)0);
            if (!SetFileInformationByHandle(handle, DispositionInfo, info, 1))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    armed ? "the staging file could not be marked for deletion"
                          : "the staging file could not be unmarked for deletion");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(info);
        }
    }

    private static void Rename(SafeFileHandle handle, string target)
    {
        byte[] name = System.Text.Encoding.Unicode.GetBytes(target);
        int lengthAt = IntPtr.Size * 2;
        int nameAt = lengthAt + 4;
        int size = nameAt + name.Length + 2;
        IntPtr info = Marshal.AllocHGlobal(size);
        try
        {
            for (int index = 0; index < size; index++) Marshal.WriteByte(info, index, 0);
            Marshal.WriteByte(info, 0, 1);
            Marshal.WriteIntPtr(info, IntPtr.Size, IntPtr.Zero);
            Marshal.WriteInt32(info, lengthAt, name.Length);
            Marshal.Copy(name, 0, (IntPtr)(info.ToInt64() + nameAt), name.Length);
            int deadline = Environment.TickCount + RenameRetryMs;
            for (;;)
            {
                if (SetFileInformationByHandle(handle, RenameInfo, info, size)) return;
                int error = Marshal.GetLastWin32Error();
                // A reader that has the target open without FILE_SHARE_DELETE
                // blocks the replacement. Those readers hold it for one read.
                bool busy = error == 5 || error == 32 || error == 33;
                if (!busy || Environment.TickCount >= deadline)
                {
                    throw new Win32Exception(error, "the file could not be put in place");
                }
                System.Threading.Thread.Sleep(RenamePollMs);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(info);
        }
    }
}
`

// One line, separators included: a missing `;` here is a parse error that
// reaches the caller as a refusal to write, indistinguishable from a file that
// could not be made private.
const COMMAND =
  "$ErrorActionPreference = 'Stop'; " +
  "try { " +
  `Add-Type -TypeDefinition $env:${SOURCE_VARIABLE} -Language CSharp; ` +
  `[ClaxedoPrivateFile]::Run($env:${STAGING_VARIABLE}, $env:${TARGET_VARIABLE}) ` +
  "} catch { " +
  // A .NET throw arrives wrapped, and the wrapper's message is the one that says nothing useful.
  "$reason = $_.Exception; if ($reason.InnerException) { $reason = $reason.InnerException }; " +
  "[Console]::Error.WriteLine($reason.Message); exit 1 }"

/** Absolute, so `PATH` cannot decide which interpreter enforces the permissions. */
export function powershellPath() {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

export type WindowsDescriptor = {
  owner: string
  inheritanceBlocked: boolean
  /** Each ACE as SDDL spells it, e.g. `A;;FA;;;S-1-5-21-...`. */
  entries: string[]
}

/**
 * Owner, protection flag and entries read out of SDDL text. Windows renders
 * the descriptor it stored, not the one requested: a DACL set as `D:P` reads
 * back as `D:PAI`, so the flag is tested for `P` rather than compared as text.
 */
export function parseSddl(sddl: string): WindowsDescriptor {
  const parsed = /^O:(\S+?)D:([A-Z]*)((?:\([^()]*\))*)$/.exec(sddl)
  if (!parsed) throw new Error(`no descriptor could be read from ${sddl}`)
  return {
    owner: parsed[1]!,
    inheritanceBlocked: parsed[2]!.includes("P"),
    entries: [...parsed[3]!.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]!),
  }
}

/** The shape {@link writeWindowsPrivateFile} creates: `sid` owns the file and is the only principal granted anything. */
export function isOwnerOnlyDescriptor(descriptor: WindowsDescriptor, sid: string) {
  return descriptor.owner === sid
    && descriptor.inheritanceBlocked
    && descriptor.entries.length === 1
    && descriptor.entries[0] === `A;;FA;;;${sid}`
}

/**
 * The current user's SID and a file's stored descriptor, from one interpreter
 * run. The path travels in the environment so no quoting rule of PowerShell's
 * can turn it into code.
 */
export function readWindowsFileProtection(file: string): Promise<{ sid: string; descriptor: WindowsDescriptor }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        "$ErrorActionPreference = 'Stop'; " +
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
        `(Get-Acl -LiteralPath $env:${TARGET_VARIABLE}).GetSecurityDescriptorSddlForm('Access,Owner')`,
      ],
      { env: environment({ [TARGET_VARIABLE]: file }), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    )
    let out = ""
    let diagnostics = ""
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString() })
    child.stderr.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString()}`.slice(0, 2_000) })
    child.on("error", (error) => reject(new Error(`Could not read the protection of ${file}: ${error.message}`, { cause: error })))
    child.on("close", (code) => {
      const [sid, sddl] = out.trim().split(/\r?\n/)
      if (code !== 0 || !sid?.startsWith("S-1-") || !sddl) {
        return reject(new Error(`Could not read the protection of ${file}: ${diagnostics.trim() || `the interpreter exited with ${code}`}`))
      }
      try {
        resolve({ sid, descriptor: parseSddl(sddl.trim()) })
      } catch (error) {
        reject(error)
      }
    })
  })
}

/**
 * A minimal environment, not this process's own: the control plane's
 * environment holds the signing keys and service tokens `harnessSpawnEnv`
 * exists to keep out of child processes. The secret is not among them — it
 * travels on stdin and appears in no argument, variable or diagnostic.
 */
function environment(variables: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = { ...variables }
  for (const name of ["SystemRoot", "windir", "PATH", "PATHEXT", "TEMP", "TMP", "COMSPEC"]) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** Bounded, so a wedged interpreter fails the write rather than hanging a sign-in. */
const TIMEOUT_MS = 60_000

/** How long a cancelled runner is given to delete its own staging file before it is killed. */
const ABORT_GRACE_MS = 5_000

/**
 * Whether a finished runner actually published, decided from what it reported
 * rather than from the fact that it stopped.
 *
 * A run that exits zero without confirming is the case that used to resolve as
 * a success: a broken pipe truncates the payload, the runner refuses to publish
 * and unwinds cleanly, and the caller is told its credential was written. A
 * cancellation surfaces the failure that caused it, never the runner's
 * complaint about being cancelled.
 */
export type RunnerEnding = {
  code: number | null
  published: boolean
  /** The caller-side failure that started a cancellation, if one did. */
  cancellation?: { failure: unknown }
  /** Whatever the runner said, already bounded and stripped of newlines. */
  diagnostics: string
  /** A write to the runner that never landed, which is how a payload gets truncated. */
  transportFailure?: string
}

export function privateWriteEnding(ending: RunnerEnding): { failure: unknown } | undefined {
  if (ending.cancellation) return ending.cancellation
  if (ending.published && ending.code === 0) return undefined
  if (ending.diagnostics) return { failure: ending.diagnostics }
  if (ending.transportFailure) return { failure: `the payload could not be delivered: ${ending.transportFailure}` }
  if (ending.code !== 0) return { failure: `the runner exited with ${ending.code}` }
  return { failure: "the runner stopped without publishing the file" }
}

export type PrivateStagingReport = {
  /** The descriptor the staging file was born with, read back through its own handle. */
  sddl: string
  /** The process holding that handle, so a caller can establish what happens when it dies. */
  holder: number | undefined
}

export type WindowsPrivateFileInput = {
  target: string
  /** A name nothing else knows; it is created exclusively and never resolved again. */
  staging: string
  contents: Uint8Array
  /**
   * Runs once the staging file exists and its descriptor has been verified, and
   * before any byte of `contents` is written. Nothing in the product passes it —
   * it is how a test occupies the moment an attacker would have to win, instead
   * of racing it. A throw cancels the write.
   */
  beforeWrite?: (report: PrivateStagingReport) => void | Promise<void>
}

/**
 * What survives what.
 *
 * Before receiving secret bytes, the runner marks the staging file for
 * deletion when its handle closes. The mark remains armed during the write,
 * including process termination. Publication clears it before attempting the
 * rename; a process failure during that attempt or its retry wait can leave
 * an owner-only staging file. Power-loss cleanup is not guaranteed.
 *
 * Cancellation before sending the payload asks the runner not to publish.
 * The kill is a backstop if it will not answer. Once a complete payload has
 * been sent, a timeout can race publication and its outcome is ambiguous.
 */
export function writeWindowsPrivateFile(input: WindowsPrivateFileInput): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", COMMAND],
      {
        env: environment({ [STAGING_VARIABLE]: input.staging, [TARGET_VARIABLE]: input.target, [SOURCE_VARIABLE]: RUNNER_SOURCE }),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    )

    let out = ""
    let diagnostics = ""
    let ready = false
    let outcome: { failure: unknown } | undefined
    let published = false
    let transportFailure: string | undefined
    let killer: ReturnType<typeof setTimeout> | undefined

    const timer = setTimeout(() => cancel(refusal(`no answer within ${TIMEOUT_MS}ms`)), TIMEOUT_MS)

    const refusal = (reason: string) =>
      new PrivateFileError(`Could not create ${input.target} as a private file on Windows: ${reason}`)

    /**
     * Ask the runner to discard rather than killing it: only the runner can
     * delete through the handle that owns the file, and its disposition is
     * already armed if it never gets the chance.
     */
    const cancel = (failure: unknown) => {
      if (outcome) return
      outcome = { failure }
      clearTimeout(timer)
      child.stdin.end(payloadFrame(ABORT, 0))
      killer = setTimeout(() => child.kill(), ABORT_GRACE_MS)
    }

    // Kept, not discarded: a write that never landed is how a payload gets
    // truncated, and the runner then refuses to publish. Silently dropping it
    // is what let that refusal read as a success.
    child.stdin.on("error", (error) => {
      transportFailure ??= error.message
    })
    child.on("error", (error) => {
      if (outcome) return
      outcome = { failure: refusal(`the interpreter could not be started: ${error.message}`) }
      clearTimeout(timer)
    })
    // The runner writes nothing but the one line; anything else is a diagnostic
    // about the file, never about its contents, and is bounded before it is used.
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics = `${diagnostics}${chunk.toString()}`.slice(0, 2_000)
    })

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes("PUBLISHED")) published = true
      if (ready || outcome || !out.includes("\n")) return
      ready = true
      const line = out.slice(0, out.indexOf("\n")).trim()
      if (!line.startsWith("READY ")) return cancel(refusal(`unexpected answer ${JSON.stringify(line.slice(0, 200))}`))
      // Deferred, so a synchronous throw from the callback lands in the catch
      // below instead of escaping this event handler.
      Promise.resolve()
        .then(() => input.beforeWrite?.({ sddl: line.slice("READY ".length), holder: child.pid }))
        .then(() => {
          if (outcome) return
          child.stdin.write(payloadFrame(COMMIT, input.contents.length))
          child.stdin.end(Buffer.from(input.contents))
        })
        .catch(cancel)
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (killer) clearTimeout(killer)
      const ending = privateWriteEnding({
        code,
        published,
        ...(outcome ? { cancellation: outcome } : {}),
        diagnostics: diagnostics.replaceAll(/\s+/g, " ").trim().slice(0, 300),
        ...(transportFailure ? { transportFailure } : {}),
      })
      if (!ending) return resolve()
      // A cancellation carries the caller's own failure through unchanged;
      // anything else is this module's refusal to claim a write it cannot see.
      reject(ending === outcome ? ending.failure : refusal(String(ending.failure)))
    })
  })
}
