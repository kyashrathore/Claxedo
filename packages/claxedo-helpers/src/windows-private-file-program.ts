import { Buffer } from "node:buffer"

/**
 * The program the Windows runner executes, and the frames and answers it
 * exchanges with this process over its stdin and stdout.
 *
 * One runner serves many requests in order. Each is a request frame naming the
 * staging and target paths, answered `READY <sddl>` or `FAILED <reason>`; after
 * `READY`, a payload frame that either commits bytes or aborts, answered
 * `PUBLISHED` or `FAILED <reason>`. `FAILED` leaves the runner serving the next
 * request. `FATAL <reason>` means the stream can no longer be trusted and the
 * runner is exiting.
 */

export const SOURCE_VARIABLE = "CLAXEDO_PRIVATE_FILE_SOURCE"

export const SERVING = "SERVING"
export const READY = "READY "
export const PUBLISHED = "PUBLISHED"
export const FAILED = "FAILED "
export const FATAL = "FATAL "

const REQUEST_MAGIC = "CLXR1"
const PAYLOAD_MAGIC = "CLXD1"
export const REQUEST_HEADER_BYTES = REQUEST_MAGIC.length + 4 + 4
export const PAYLOAD_HEADER_BYTES = PAYLOAD_MAGIC.length + 1 + 8
export const COMMIT = 1
export const ABORT = 0

/** UTF-16LE, the encoding `CreateFileW` takes, so a name reaches it unchanged. */
export function requestFrame(staging: string, target: string) {
  const stagingBytes = Buffer.from(staging, "utf16le")
  const targetBytes = Buffer.from(target, "utf16le")
  const header = Buffer.alloc(REQUEST_HEADER_BYTES)
  header.write(REQUEST_MAGIC, 0, "ascii")
  header.writeUInt32LE(stagingBytes.length, REQUEST_MAGIC.length)
  header.writeUInt32LE(targetBytes.length, REQUEST_MAGIC.length + 4)
  return Buffer.concat([header, stagingBytes, targetBytes])
}

/**
 * Length-framed, so the end of the pipe is never mistaken for the end of the
 * secret. A closed stdin, a killed writer and a half-delivered payload all
 * reach the runner as "do not publish" instead of as an empty or truncated
 * credential file — which is what an unframed `CopyTo` would have published.
 */
export function payloadFrame(verb: typeof COMMIT | typeof ABORT, length: number) {
  const header = Buffer.alloc(PAYLOAD_HEADER_BYTES)
  header.write(PAYLOAD_MAGIC, 0, "ascii")
  header.writeUInt8(verb, PAYLOAD_MAGIC.length)
  header.writeBigUInt64LE(BigInt(length), PAYLOAD_MAGIC.length + 1)
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
 *
 * A payload whose write fails part-way is still read to its end, so the next
 * request frame starts where this process expects it to.
 */
export const RUNNER_SOURCE = `
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

    private sealed class StreamLost : Exception
    {
        public StreamLost(string message) : base(message) { }
    }

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
    private const int RequestHeaderBytes = ${REQUEST_HEADER_BYTES};
    private const int PayloadHeaderBytes = ${PAYLOAD_HEADER_BYTES};
    private const int MaxPathBytes = 65534;

    public static void Serve()
    {
        Stream input = Console.OpenStandardInput();
        string sid = WindowsIdentity.GetCurrent().User.Value;
        Answer("${SERVING}");
        for (;;)
        {
            try
            {
                string[] paths = ReadRequest(input);
                if (paths == null) return;
                Run(input, sid, paths[0], paths[1]);
            }
            catch (StreamLost lost)
            {
                Answer("${FATAL}" + lost.Message);
                return;
            }
            catch (Exception reason)
            {
                Answer("${FAILED}" + Describe(reason));
            }
        }
    }

    // Null only at a clean end of input between requests, which is how this
    // process is told to stop.
    private static string[] ReadRequest(Stream input)
    {
        byte[] header = new byte[RequestHeaderBytes];
        int first = input.Read(header, 0, RequestHeaderBytes);
        if (first <= 0) return null;
        if (!ReadExactly(input, header, first, RequestHeaderBytes)) throw new StreamLost("the request ended early");
        if (System.Text.Encoding.ASCII.GetString(header, 0, 5) != "${REQUEST_MAGIC}")
        {
            throw new StreamLost("the caller sent an unrecognised request");
        }
        int stagingBytes = BitConverter.ToInt32(header, 5);
        int targetBytes = BitConverter.ToInt32(header, 9);
        if (stagingBytes < 0 || stagingBytes > MaxPathBytes || targetBytes < 0 || targetBytes > MaxPathBytes)
        {
            throw new StreamLost("the caller sent an impossible path length");
        }
        byte[] names = new byte[stagingBytes + targetBytes];
        if (!ReadExactly(input, names, 0, names.Length)) throw new StreamLost("the request ended early");
        return new string[] {
            System.Text.Encoding.Unicode.GetString(names, 0, stagingBytes),
            System.Text.Encoding.Unicode.GetString(names, stagingBytes, targetBytes),
        };
    }

    private static void Run(Stream input, string sid, string staging, string target)
    {
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
            Answer("${READY}" + Verify(file, sid));
            if (!Fill(input, file)) throw new Exception("the caller cancelled the write");
            file.Flush(true);
            Arm(handle, false);
            Rename(handle, target);
            published = true;
            Answer("${PUBLISHED}");
        }
        finally
        {
            if (!published) Arm(handle, true);
            file.Dispose();
        }
    }

    // Returns whether the caller asked for a publication. Anything short of the
    // whole payload ends the stream, never a short write.
    private static bool Fill(Stream input, FileStream file)
    {
        byte[] header = new byte[PayloadHeaderBytes];
        if (!ReadExactly(input, header, 0, PayloadHeaderBytes)) throw new StreamLost("the payload ended early");
        if (System.Text.Encoding.ASCII.GetString(header, 0, 5) != "${PAYLOAD_MAGIC}")
        {
            throw new StreamLost("the caller sent an unrecognised payload");
        }
        if (header[5] != ${COMMIT}) return false;
        long length = BitConverter.ToInt64(header, 6);
        if (length < 0) throw new StreamLost("the caller sent a negative length");
        byte[] buffer = new byte[65536];
        long remaining = length;
        Exception failure = null;
        while (remaining > 0)
        {
            int wanted = (int)Math.Min(remaining, buffer.Length);
            if (!ReadExactly(input, buffer, 0, wanted)) throw new StreamLost("the payload ended early");
            if (failure == null)
            {
                try { file.Write(buffer, 0, wanted); }
                catch (Exception reason) { failure = reason; }
            }
            remaining -= wanted;
        }
        if (failure != null) throw failure;
        return true;
    }

    private static bool ReadExactly(Stream input, byte[] buffer, int filled, int count)
    {
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

    private static string Describe(Exception reason)
    {
        string message = reason.Message;
        Win32Exception native = reason as Win32Exception;
        if (native != null) message += " (Windows error " + native.NativeErrorCode + ")";
        return message.Replace('\\r', ' ').Replace('\\n', ' ');
    }

    private static void Answer(string line)
    {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
    }
}
`

// One line, separators included: a missing `;` here is a parse error that
// reaches the caller as a runner that exited before serving.
export const RUNNER_COMMAND =
  "$ErrorActionPreference = 'Stop'; " +
  "try { " +
  `Add-Type -TypeDefinition $env:${SOURCE_VARIABLE} -Language CSharp; ` +
  "[ClaxedoPrivateFile]::Serve() " +
  "} catch { " +
  // A .NET throw arrives wrapped, and the wrapper's message is the one that says nothing useful.
  "$reason = $_.Exception; if ($reason.InnerException) { $reason = $reason.InnerException }; " +
  "[Console]::Error.WriteLine($reason.Message); exit 1 }"
