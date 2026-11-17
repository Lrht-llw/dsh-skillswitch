# dsh-skillswitch

[![npm version](https://img.shields.io/npm/v/dsh-skillswitch)](https://www.npmjs.com/package/dsh-skillswitch)
[![license](https://img.shields.io/npm/l/dsh-skillswitch)](LICENSE)

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin that adds a **Skills** page to the left sidebar of the Web
client and gives every installed skill one shared on/off switch.

## What it does

- **Lists every skill** the current session can see: name, source (`user-agents`,
  `bundled`, packaged provider, …), description, and whether it can be uninstalled.
- **Turns a skill on or off.** A disabled skill is served by a shadow skill provider
  whose invocation flags are both false, so it disappears from the session skill
  catalog at the next model request, the `skill` tool refuses to load it, and `/name`
  gestures no longer inject it. The skill's own files are left untouched.
- **Answers a stale call.** When the model calls `skill` for a disabled skill, a
  `tools/pre-execute` gate answers with the local “该 skill 已被关闭 …” reason. The
  message tells the model to ask the user first and then call
  `skill_manage(action="enable")`; the page reflects the same state immediately.
- **Uninstalls user-installed skills.** Only skill folders under writable roots
  (`$DSH_HOME/skills`, `$DSH_AGENTS_HOME/skills`, `<project>/.dsh/skills`,
  `<project>/.agents/skills`) are deleted — the whole bundle directory or the flat
  `.md` file, plus any same-name entry in those roots. Shipped and packaged skills
  cannot be deleted from the application; they can only be turned off.

## Why another skill plugin

Most skill managers only hide a skill from the picker. This one changes what the
**model** sees:

- The shadow provider is registered once in the global registry layer **and once in
  every live agent scope**, so it also wins against packaged or preset-scoped
  providers. Disabling a built-in skill such as `office` really removes it from the
  model catalog.
- The switch state is shared by the page and the model: the agent can ask you to turn
  a skill back on, and the page shows the result of that decision.

## Install

Requires DSH **>= 0.2.2-rc.3**. Published on npm as
[`dsh-skillswitch`](https://www.npmjs.com/package/dsh-skillswitch).

1. **From npm (recommended)** — ask the agent to run:

   ```
   plugin_manager install_bundle target="dsh-skillswitch"
   ```

   Installed this way, the Plugins page can check for and apply updates.

2. **From GitHub** — ask the agent to run:

   ```
   plugin_manager install_bundle target=https://github.com/Lrht-llw/dsh-skillswitch.git
   ```

3. **From a local checkout** — open **Plugins** in the left sidebar, choose **Add plugin**,
   and point it at this directory; or run:

   ```
   plugin_manager install_bundle target=<absolute path to this directory>
   ```

A page entry named **Skills** appears in the left sidebar between Plugins and
Automation tasks. If the page does not appear right away, refresh the Web client.

## Use it

- **Page**: toggle a skill on or off with the switch on its row; press Uninstall twice
  to confirm deletion. Shipped skills show “shipped — disable only”.
- **Model tool**: `skill_manage` with `action: "list" | "enable" | "disable" | "uninstall"`
  and the exact skill name.

Switch state lives in `$DSH_HOME/skillswitch/state.json`. Removing the plugin does not
delete that file; delete the folder when you no longer need the saved switches.

## How it works

| Piece | Mechanism |
|---|---|
| Hide a skill | A shadow `SkillProvider` (rank `-1`, both invocation flags false) registered in the global layer and in each agent scope |
| Block a call | `tools/pre-execute` denial with the localized “disabled” reason |
| Page data | An authenticated exact Fetch route on `/api/skillswitch`, owner-only through the DSH connection fence |
| Agent operations | `skill_manage` tool sharing the same Host implementation as the page |
| Persistence | JSON state file under `$DSH_HOME/skillswitch` |

## Limitations

- The switch is profile-wide and takes effect from the next model request in every
  session. Content a session already loaded stays in that session's history; the
  engine appends a replacement catalog that retires the old list.
- Shipped and packaged skills cannot be uninstalled through the plugin (their files
  live inside the application), only switched off.
- Uninstalling a user skill deletes files and cannot be undone.

## License

Apache-2.0. See [LICENSE](LICENSE).
