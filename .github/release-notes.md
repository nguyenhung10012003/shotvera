## Download

| Platform | File |
|---|---|
| macOS, Apple Silicon (M1 and later) | `Shotvera_{{version}}_aarch64.dmg` |
| macOS, Intel | `Shotvera_{{version}}_x64.dmg` |
| Windows 10 / 11, 64-bit | `Shotvera_{{version}}_x64-setup.exe` (recommended) or `Shotvera_{{version}}_x64_en-US.msi` |
| Linux, any distribution | `Shotvera_{{version}}_amd64.AppImage` |
| Debian / Ubuntu | `Shotvera_{{version}}_amd64.deb` |
| Fedora / openSUSE | `Shotvera-{{version}}-1.x86_64.rpm` |

### First launch

**macOS.** Apple has not notarized these builds yet, so you need to confirm the first launch:

1. Open the `.dmg` and drag Shotvera to Applications.
2. Open Shotvera. macOS blocks it the first time.
3. Go to **System Settings → Privacy & Security** and click **Open Anyway**. You can instead run `xattr -dr com.apple.quarantine /Applications/Shotvera.app` in Terminal.
4. Allow **Screen Recording** when asked, then restart Shotvera.

After an update, macOS may ask for Screen Recording permission again.

**Windows.** The installer is not code-signed yet. If SmartScreen warns you, click **More info**, then **Run anyway**.

**Linux.** Make the AppImage executable with `chmod +x Shotvera_*.AppImage`, then run it. On Wayland, the desktop portal asks for permission to capture the screen.

**AI features** need your own [Anthropic API key](https://console.anthropic.com/). Paste it into the AI panel or into Settings → AI.
