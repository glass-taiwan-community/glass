<p align="center">
  <a href="https://pickle.com/glass">
   <img src="./public/assets/banner.gif" alt="Logo">
  </a>

  <h1 align="center">Glass by Pickle: Digital Mind Extension 🧠</h1>

</p>


<p align="center">
  <a href="https://discord.gg/UCZH5B5Hpd"><img src="./public/assets/button_dc.png" width="80" alt="Pickle Discord"></a>&ensp;<a href="https://pickle.com"><img src="./public/assets/button_we.png" width="105" alt="Pickle Website"></a>&ensp;<a href="https://x.com/intent/user?screen_name=leinadpark"><img src="./public/assets/button_xe.png" width="109" alt="Follow Daniel"></a>
</p>

> **Taiwan Community Fork**: This repository is maintained by the Glass Taiwan Community at [glass-taiwan-community](https://github.com/glass-taiwan-community).

## Why this fork exists

This fork was initiated by contributors in the Taiwan community who actively use and depend on `glass`.

As upstream maintenance activity slowed over time, this fork was created to provide a space where community members can collaborate, discuss changes, and move improvements forward in a more timely manner.

The primary goal of this fork is to lower the contribution barrier, coordinate community efforts, and experiment with maintenance approaches that may later be proposed upstream.

This fork does not claim to replace the upstream project and remains open to contributors from any region.

## Community Fork Additions

Beyond upstream, this fork adds (macOS):

- **Keyboard-driven overlay** — operate Glass entirely from the keyboard so it never steals focus from your foreground app (see Keyboard Shortcuts).
- **Voice-to-Ask** — hold a key, speak a question, and Ask answers with your live Listen conversation as context, without switching apps. Opt-in, off by default.
- **STT language selection** — choose transcription language (English / 繁體中文).
- **Whole-session summary** — a final summary generated when a Listen session ends.
- **Saved screen captures** — optionally keep the screenshot from a screen-only Ask in your activity history for later review. Opt-in, off by default, 30-day cleanup.
- **Readable streaming** — the Ask window no longer yanks you to the bottom while a long answer streams; it follows only while you're at the bottom.

---

🤖 **Fast, light & open-source**—Glass lives on your desktop, sees what you see, listens in real time, understands your context, and turns every moment into structured knowledge.

💬 **Proactive in meetings**—it surfaces action items, summaries, and answers the instant you need them.

🫥️ **Truly invisible**—never shows up in screen recordings, screenshots, or your dock; no always-on capture or hidden sharing.

To have fun building with us, join our [Discord](https://discord.gg/UCZH5B5Hpd)!

## Instant Launch

⚡️  Skip the setup—launch instantly with our ready-to-run macOS app.  [[Download Here]](https://www.dropbox.com/scl/fi/znid09apxiwtwvxer6oc9/Glass_latest.dmg?rlkey=gwvvyb3bizkl25frhs4k1zwds&st=37q31b4w&dl=1)

## Quick Start (Local Build)

### Prerequisites

First download & install [Python](https://www.python.org/downloads/) and [Node](https://nodejs.org/en/download).
If you are using Windows, you need to also install [Build Tools for Visual Studio](https://visualstudio.microsoft.com/downloads/)

Ensure you're using Node.js version 20.x.x to avoid build errors with native dependencies.

```bash
# Check your Node.js version
node --version

# If you need to install Node.js 20.x.x, we recommend using nvm:
# curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
# nvm install 20
# nvm use 20
```

### Installation

```bash
npm run setup
```

## Highlights


### Ask: get answers based on all your previous screen actions & audio

<img width="100%" alt="booking-screen" src="./public/assets/00.gif">

### Meetings: real-time meeting notes, live summaries, session records

<img width="100%" alt="booking-screen" src="./public/assets/01.gif">

### Use your own API key, or sign up to use ours (free)

<img width="100%" alt="booking-screen" src="./public/assets/02.gif">

**Currently Supporting:**
- OpenAI API: Get OpenAI API Key [here](https://platform.openai.com/api-keys)
- Gemini API: Get Gemini API Key [here](https://aistudio.google.com/apikey)
- Deepgram API (speech-to-text): Get Deepgram API Key [here](https://console.deepgram.com/)
- Local LLM Ollama & Whisper

### Liquid Glass Design (coming soon)

<img width="100%" alt="booking-screen" src="./public/assets/03.gif">

<p>
  for a more detailed guide, please refer to this <a href="https://www.youtube.com/watch?v=qHg3_4bU1Dw">video.</a>
  <i style="color:gray; font-weight:300;">
    we don't waste money on fancy vids; we just code.
  </i>
</p>


## Keyboard Shortcuts

This fork adds full keyboard control of the overlay (macOS), so you can drive Glass without clicking — which would pull focus away from the app you're working in. Every shortcut below is rebindable in Settings.

**Window**
- `Cmd + \` — show / hide the overlay
- `Cmd + Arrows` — nudge the window (80px)
- `Cmd + Shift + Alt + Arrows` — snap the window to a screen edge

**Ask**
- `Cmd + Enter` — open Ask; press again on an empty box to analyze your screen
- `Cmd + Shift + Up/Down` — scroll the Ask response
- `Cmd + Alt + \` — close the Ask window
- **Hold Right-⌘** — speak a question; the transcript + screenshot go to Ask (opt-in; enable "Voice input" in Settings)

**Listen**
- `Cmd + Alt + L` — start / stop / dismiss a Listen session
- `Cmd + Alt + Up/Down` — move the insight selection (or scroll the transcript)
- `Cmd + Alt + Enter` — ask about the selected insight
- `Cmd + Alt + T` — switch between insights and transcript

## Repo Activity

![Alt](https://repobeats.axiom.co/api/embed/a23e342faafa84fa8797fa57762885d82fac1180.svg "Repobeats analytics image")

## Contributing

We love contributions! Feel free to open issues for bugs or feature requests. For detailed guide, please see our [contributing guide](/CONTRIBUTING.md).
> Currently, we're working on a full code refactor and modularization. Once that's completed, we'll jump into addressing the major issues.

### Contributors

<a href="https://github.com/pickle-com/glass/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=pickle-com/glass" />
</a>

### Help Wanted Issues

We have a list of [help wanted](https://github.com/pickle-com/glass/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22%F0%9F%99%8B%E2%80%8D%E2%99%82%EF%B8%8Fhelp%20wanted%22) that contain small features and bugs which have a relatively limited scope. This is a great place to get started, gain experience, and get familiar with our contribution process.


### 🛠 Current Issues & Improvements

| Status | Issue                          | Description                                       |
|--------|--------------------------------|---------------------------------------------------|
| 🚧 WIP      | Liquid Glass                    | Liquid Glass UI for MacOS 26 |

### Changelog

- Jul 5: Now support Gemini, Intel Mac supported
- Jul 6: Full code refactoring has done.
- Jul 7: Now support Claude, LLM/STT model selection
- Jul 8: Now support Windows(beta), Improved AEC by Rust(to seperate mic/system audio), shortcut editing(beta)
- Jul 8: Now support Local LLM & STT, Firebase Data Storage 


## About Pickle

**Our mission is to build a living digital clone for everyone.** Glass is part of Step 1—a trusted pipeline that transforms your daily data into a scalable clone. Visit [pickle.com](https://pickle.com) to learn more.

## Star History
[![Star History Chart](https://api.star-history.com/svg?repos=pickle-com/glass&type=Date)](https://www.star-history.com/#pickle-com/glass&Date)
