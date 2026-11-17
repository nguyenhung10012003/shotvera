# Security Policy

Shotvera sees what is on your screen and stores an API key. We take security reports seriously, and we thank you for helping keep its users safe.

## Supported versions

Shotvera is in early development. Only the latest release gets security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through one of these channels:

- GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**.
- Email **nguyenhung1012003@gmail.com** with `[Shotvera security]` in the subject.

Please include:

- the affected version, your operating system and its version, and your monitor setup if it matters;
- steps to reproduce, or a proof of concept;
- the impact you expect, such as reading screen content, leaking the API key, or reading or writing files outside the app's folders;
- whether you want to be credited, and under which name.

What to expect:

- We acknowledge your report within **3 business days**.
- We send a first assessment within **10 business days**.
- For confirmed issues, we ship a fix in a patch release and publish a security advisory. If you want credit, we name you in the release notes.
- We aim to disclose within **90 days** of your report, on a date we agree with you.

Please give us reasonable time to fix the issue before you make it public. While testing, do not access other people's data or degrade their systems.

## Security model

This section describes how Shotvera is meant to behave. It should help you decide whether something counts as a vulnerability.

### Screen content

- Shotvera takes a screenshot or records the screen only when you start it:
  - with a global shortcut;
  - from the menu bar or tray;
  - with the `--capture` or `--record` command-line flag.
- While a recording runs, a border marks the recorded area and the menu bar icon is red.
- The microphone is used only for recordings where you turned sound on. The sound is written into the video file.
- Captures stay on your device:
  - images and recordings you save go to the folder you choose (`Pictures/Shotvera` by default);
  - the app's data folder keeps your 60 most recent captures for the "Recent" list;
  - copied images go to the system clipboard.
- Shotvera has no telemetry, no analytics, no crash reporting and no servers of its own.

### Updates

- To look for updates, Shotvera downloads `latest.json` from the project's GitHub releases. This happens shortly after launch, then every 6 hours, unless it is turned off in Settings → About. The request carries no information about you or your captures.
- Each update is signed with the project's private key. Shotvera verifies the signature against the public key built into the app, and refuses an update that does not match.
- Updates are installed only after you click *Install*, unless you turned on automatic installation.

### AI features (optional)

- Apart from update checks, nothing goes to a network service until you use an AI feature: the chat, a quick action, or "Capture & ask AI" / "Extract text".
- When you do, Shotvera sends to `https://api.anthropic.com`, and nowhere else:
  - the **selected region**, with your annotations drawn on it, scaled down so its longest edge is at most 1568 px;
  - a text list of the current annotations;
  - your chat messages.
- Your Anthropic API key lives in the operating system's credential store: macOS Keychain, Windows Credential Manager, or Secret Service on Linux. Shotvera never writes it to a settings file or anywhere else on disk.
- While making requests, the capture window's webview holds the key in memory. That webview runs only Shotvera's own bundled code, under a strict Content Security Policy:
  - remote scripts cannot load;
  - the only network destination allowed is the Anthropic API.

### Local attack surface

- The Rust backend accepts IPC commands only from Shotvera's own windows, through the Tauri capability allowlist in `src-tauri/capabilities/`.
- Some commands take a file path: opening, copying or deleting a history item. They resolve the path and reject anything outside the history folder.
- The webview's `asset:` protocol can read only the history folder.
- On macOS, Shotvera enables Tauri's `macOSPrivateApi`. It is used only for the translucent background of the menu-bar popover.

### In scope

- Screen content or captures reaching anyone besides the user, or besides Anthropic when the user uses an AI feature.
- The API key leaking through the credential store, logs, crash output or the webview.
- Path traversal, or reading, writing or deleting files outside the app's folders through IPC commands.
- Script injection into a Shotvera webview, for example through AI responses (rendered as Markdown), window titles or file names.
- Bypassing the Content Security Policy or the capability allowlist.
- Getting Shotvera to install an update that is not signed with the project's key.

### Out of scope

- Attacks by someone who already controls your user account, such as malware running as you, a debugger attached to the app, or a modified app bundle.
- Mistakes in the AI model's answers, such as inaccurate text extraction or a misplaced annotation. Please report these as regular issues.
- Vulnerabilities in third-party dependencies (Tauri, WebKit/WebView2/WebKitGTK, the Anthropic SDK) that do not affect Shotvera specifically. Report those upstream, and let us know if Shotvera needs to update or work around them.
- Missing code signing or notarization in development builds.
