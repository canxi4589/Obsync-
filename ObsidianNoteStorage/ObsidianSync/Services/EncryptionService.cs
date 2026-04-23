using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;

namespace ObsidianSync.Services;

/// <summary>
/// AES-256-GCM encryption. Password derived via PBKDF2-SHA256.
/// Password itself stored via Windows DPAPI — no plaintext on disk.
/// File format: [salt 16B][nonce 12B][tag 16B][ciphertext]
/// </summary>
[SupportedOSPlatform("windows")]
public static class EncryptionService
{
    private const int SaltSize = 16;
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private const int KeySize = 32;
    private const int Iterations = 200_000;

    // DPAPI credential storage key
    private const string DpapiLabel = "ObsidianSync_MasterKey";

    // ── Password management (DPAPI) ──────────────────────────────────────────

    public static bool HasPassword()
    {
        var stored = ReadDpapi();
        return stored is not null;
    }

    public static void SetPassword(string password)
    {
        var bytes = Encoding.UTF8.GetBytes(password);
        var encrypted = ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser);
        var encoded = Convert.ToBase64String(encrypted);

        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ObsidianSync");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, ".key"), encoded);

        Array.Clear(bytes, 0, bytes.Length);
    }

    public static string? GetPassword()
    {
        var raw = ReadDpapi();
        if (raw is null) return null;
        return Encoding.UTF8.GetString(raw);
    }

    private static byte[]? ReadDpapi()
    {
        var path = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "ObsidianSync", ".key");

        if (!File.Exists(path)) return null;

        try
        {
            var encoded = File.ReadAllText(path);
            var encrypted = Convert.FromBase64String(encoded);
            return ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser);
        }
        catch
        {
            return null;
        }
    }

    // ── Encrypt / Decrypt ────────────────────────────────────────────────────

    public static void EncryptFile(string sourcePath, string destPath, string password)
    {
        var plaintext = File.ReadAllBytes(sourcePath);
        var cipherBytes = Encrypt(plaintext, password);
        Directory.CreateDirectory(Path.GetDirectoryName(destPath)!);
        File.WriteAllBytes(destPath, cipherBytes);
    }

    public static void DecryptFile(string sourcePath, string destPath, string password)
    {
        var cipherBytes = File.ReadAllBytes(sourcePath);
        var plaintext = Decrypt(cipherBytes, password);
        Directory.CreateDirectory(Path.GetDirectoryName(destPath)!);
        File.WriteAllBytes(destPath, plaintext);
    }

    public static byte[] Encrypt(byte[] plaintext, string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var key = DeriveKey(password, salt);

        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[TagSize];

        using var aes = new AesGcm(key, TagSize);
        aes.Encrypt(nonce, plaintext, ciphertext, tag);

        // layout: salt | nonce | tag | ciphertext
        var result = new byte[SaltSize + NonceSize + TagSize + ciphertext.Length];
        Buffer.BlockCopy(salt, 0, result, 0, SaltSize);
        Buffer.BlockCopy(nonce, 0, result, SaltSize, NonceSize);
        Buffer.BlockCopy(tag, 0, result, SaltSize + NonceSize, TagSize);
        Buffer.BlockCopy(ciphertext, 0, result, SaltSize + NonceSize + TagSize, ciphertext.Length);

        Array.Clear(key, 0, key.Length);
        return result;
    }

    public static byte[] Decrypt(byte[] data, string password)
    {
        if (data.Length < SaltSize + NonceSize + TagSize)
            throw new CryptographicException("Data too short — not a valid encrypted file.");

        var salt = data[..SaltSize];
        var nonce = data[SaltSize..(SaltSize + NonceSize)];
        var tag = data[(SaltSize + NonceSize)..(SaltSize + NonceSize + TagSize)];
        var ciphertext = data[(SaltSize + NonceSize + TagSize)..];

        var key = DeriveKey(password, salt);
        var plaintext = new byte[ciphertext.Length];

        using var aes = new AesGcm(key, TagSize);
        aes.Decrypt(nonce, ciphertext, tag, plaintext);

        Array.Clear(key, 0, key.Length);
        return plaintext;
    }

    private static byte[] DeriveKey(string password, byte[] salt) =>
        Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password),
            salt,
            Iterations,
            HashAlgorithmName.SHA256,
            KeySize);
}
