/**
 * English UI strings. This file is the source of truth: every other locale must provide the
 * same keys (the `Messages` type enforces this). `{name}` is replaced by the parameter of the same
 * name. Plural entries choose `one` or `other` from the `count` parameter.
 */
export interface Plural {
  one: string;
  other: string;
}

export const en = {
  // common
  "common.close": "Close",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.save": "Save",
  "common.saved": "Saved",
  "common.delete": "Delete",
  "common.error": "Error: {message}",

  // capture overlay
  "overlay.fullScreen": "Full screen",
  "overlay.copiedToClipboard": "Copied to clipboard",
  "overlay.savedTo": "Saved to {path}",
  "overlay.colorCopied": "Copied color {hex}",
  "overlay.magnifierHint": "C: copy color · Esc: exit",
  "overlay.noSelection": "Nothing is selected",
  "overlay.exportFailed": "Couldn't render the annotations for export",

  // annotation tools
  "tool.select": "Select / move",
  "tool.rect": "Rectangle",
  "tool.ellipse": "Ellipse",
  "tool.line": "Line",
  "tool.arrow": "Arrow",
  "tool.pen": "Pen",
  "tool.marker": "Highlighter",
  "tool.text": "Text",
  "tool.mosaic": "Blur (mosaic)",
  "tool.step": "Numbered step",
  "tool.emoji": "Emoji",

  // toolbar and tool options
  "toolbar.undo": "Undo ({shortcut})",
  "toolbar.redo": "Redo ({shortcut})",
  "toolbar.delete": "Delete selected shape (Delete)",
  "toolbar.askAi": "Ask AI about this capture (I)",
  "toolbar.ocr": "Extract text (OCR)",
  "toolbar.pin": "Pin to screen (F3)",
  "toolbar.quickSave": "Quick save",
  "toolbar.saveAs": "Save as…",
  "toolbar.close": "Close (Esc)",
  "toolbar.copy": "Copy ({shortcut})",
  "toolbar.customColor": "Custom color",
  "toolbar.fontSize": "Font size",
  "toolbar.brushSize": "Brush size",
  "toolbar.size": "Size",
  "toolbar.stroke": "Stroke",
  "toolbar.outline": "Outline",
  "toolbar.filled": "Filled",
  "toolbar.plainText": "Text",
  "toolbar.textBackground": "Background",
  "toolbar.brush": "Brush",
  "toolbar.area": "Area",

  // AI panel
  "ai.intro": "Ask anything about your capture, or let the AI edit it for you.",
  "ai.toolFailed": "Action didn't finish",
  "ai.drawing": "Drawing annotations…",
  "ai.removing": "Removing annotations…",
  "ai.added": { one: "Added {count} annotation", other: "Added {count} annotations" },
  "ai.removed": { one: "Removed {count} annotation", other: "Removed {count} annotations" },
  "ai.placeholder": "e.g. circle the Sign up button in red, hide the email…",
  "ai.stop": "Stop",
  "ai.send": "Send",
  "ai.connectTitle": "Connect Claude",
  "ai.connectBody": "Paste your Anthropic API key to use AI. The key is stored in {store} and sent only to Anthropic.",
  "ai.storeOs": "your system keychain",
  "ai.storeBrowser": "this browser (dev mode)",
  "ai.saving": "Saving…",
  "ai.saveKey": "Save API key",
  "ai.getKey": "Get an API key at console.anthropic.com",
  "ai.replyLanguage": "English",
  "ai.err.stopped": "Stopped.",
  "ai.err.auth": "Invalid API key. Check it in Settings → AI.",
  "ai.err.permission": "This API key doesn't have access to this model.",
  "ai.err.rateLimit": "Too many requests. Try again in a few minutes.",
  "ai.err.badRequest": "Invalid request: {message}",
  "ai.err.connection": "Couldn't connect to the Anthropic API. Check your internet connection.",
  "ai.err.api": "API error ({status}): {message}",
  "ai.err.refusal": "Claude declined this request.",
  "ai.err.truncated": "The response was cut off before the action finished. Try again.",

  // AI quick actions: the button label, then the prompt sent to Claude
  "quick.explain": "Explain",
  "quick.ocr": "Extract text",
  "quick.translate": "Translate",
  "quick.summarize": "Summarize",
  "quick.redact": "Redact sensitive info",
  "quick.highlight": "Highlight key points",
  "quick.debug": "Find bugs",
  "prompt.explain": "Explain what this screenshot shows.",
  "prompt.ocr":
    "Extract all the text in the image, keeping its layout and line breaks. Return only the text, in a single code block.",
  "prompt.translate":
    "Translate all the text in the image into English. If the text is already in English, ask me which language to translate it into.",
  "prompt.summarize": "Briefly summarize the key points in the image.",
  "prompt.redact":
    "Find and pixelate all personal or sensitive information in the image, such as emails, phone numbers, passwords, tokens, API keys, card numbers, addresses and faces. Then briefly list what you hid.",
  "prompt.highlight":
    "Circle and number the most important points in the image (up to 5). Add a short explanation for each number.",
  "prompt.debug":
    "Does this screenshot show an error or problem? If so, mark where it is on the image and explain how to fix it.",

  // menu-bar popover
  "home.version": "Version {version}",
  "home.settings": "Settings",
  "home.quit": "Quit Shotvera",
  "home.capture": "Capture screen",
  "home.captureHint": "Select, annotate, copy",
  "home.captureAi": "Capture & ask AI",
  "home.captureAiHint": "Explain or edit it with AI",
  "home.extractText": "Extract text",
  "home.extractTextHint": "Copy the text from a region",
  "home.recent": "Recent",
  "home.openFolder": "Open folder",
  "home.empty": "Your captures will appear here",
  "home.emptyHint": "Press {shortcut} to start",
  "home.pinHint": "Click to pin on screen",

  // settings window
  "settings.tab.general": "General",
  "settings.tab.shortcuts": "Shortcuts",
  "settings.tab.ai": "AI",
  "settings.tab.about": "About",
  "settings.language": "Language",
  "settings.saveFolder": "Save folder",
  "settings.saveFolderHint": "Used by Quick save ({shortcut})",
  "settings.change": "Change…",
  "settings.saveFormat": "Quick save format",
  "settings.closeAfterCopy": "Close after copying",
  "settings.closeAfterCopyHint": "The ✓ button and {shortcut} close the capture screen",
  "settings.launchAtLogin": "Launch at login",
  "settings.launchAtLoginHint": "Start Shotvera when you log in",
  "settings.captureShortcut": "Capture screen",
  "settings.captureShortcutHint": "Global shortcut",
  "settings.pressKeys": "Press a key combination…",
  "settings.shortcutError": "Couldn't set the shortcut: {error}",
  "settings.shortcutHint": "If the shortcut doesn't work, another app may be using it. Try a different combination.",
  "settings.inCapture": "In the capture screen",
  "settings.keys.copyClose": "Copy & close",
  "settings.keys.save": "Quick save / Save as…",
  "settings.keys.undoRedo": "Undo / Redo",
  "settings.keys.pin": "Pin to screen",
  "settings.keys.ai": "Open AI",
  "settings.keys.tools": "Tools",
  "settings.keys.nudge": "Move the selection 1 px / 10 px",
  "settings.keys.copyColor": "Copy color (while selecting)",
  "settings.keys.exit": "Exit",
  "settings.keys.doubleClick": "double-click",
  "settings.keys.arrows": "arrows",
  "settings.keys.rightClick": "right-click",
  "settings.apiKey": "Anthropic API key",
  "settings.apiKeyHint": "Stored securely in your system keychain",
  "settings.keySet": "Set",
  "settings.keyMissing": "Not set",
  "settings.keyChange": "Change",
  "settings.keyAdd": "Add",
  "settings.keyRemove": "Remove",
  "settings.model": "Model",
  "settings.model.opus": "Most capable (default)",
  "settings.model.sonnet": "Fast and balanced",
  "settings.model.haiku": "Fastest and cheapest",
  "settings.effort": "Reasoning effort",
  "settings.effortHint": "Higher is more thorough, but slower and more expensive",
  "settings.effort.low": "Fast",
  "settings.effort.medium": "Balanced",
  "settings.effort.high": "Thorough",
  "settings.aiPrivacy":
    "Your capture is sent to Anthropic only when you open the AI panel and send a message. Shotvera doesn't store images or conversations on any other server.",
  "settings.version": "Version {version}",
  "settings.tagline": "Capture, annotate, and ask AI about anything on your screen. Available for macOS, Windows and Linux.",
} satisfies Record<string, string | Plural>;

export type MessageKey = keyof typeof en;

/** The shape every locale must match: the same keys, with plural entries kept plural. */
export type Messages = { [K in MessageKey]: (typeof en)[K] extends Plural ? Plural : string };
