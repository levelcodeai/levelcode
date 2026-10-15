# LevelCode v1.4.0

Extensions from Open VSX install again, and the editor checks them before installing. Up to v1.3.1, LevelCode could not check any signed extension, so every install from Open VSX stopped at **Install Anyway**, and installed extensions never updated. This release checks what Open VSX serves against the registry's own signing key. The agent can also draw now: when structure is the point, it puts a diagram in the chat, in your theme, with boxes that open the code they name. And Gemini 4 Argon, Google's new reasoning model, gets its real context window and room to think.

## Highlights

### Extensions install verified, without Install Anyway

The editor checks every extension it downloads before installing it. In every LevelCode build until now, the module that does that check was missing: it is Microsoft's, and no open-source build includes it. So every check failed with *Signature verification was not executed*. The editor asked you to install anyway, and quietly never updated what you had.

v1.4.0 ships LevelCode's own checker in that place. It confirms that the package is exactly what Open VSX published, using the registry's signing key.

- **If you turned checking off to get past the old prompt, turn it back on.** Setting `extensions.verifySignature` to `false` stops all checking, and an upgrade leaves the setting as you set it. Remove it, or set it to `true`.
- **The key is built into the app and never downloaded.** If Open VSX ever changes it, extensions signed with the new key are refused until a LevelCode update carries that key. Extensions already installed keep working. A daily check against the registry looks for exactly that, so a change shows up first as a failed check on our side, not only as your failed installs.
- **A package that does not match is refused, with the reason.** A package that was changed after publishing, or signed with another key, is refused as untrusted, and the editor says so.
- **It confirms the package came from Open VSX, not that the code is safe.** It says nothing about what an extension does, any more than an app store's signature does.
- **An extension installed from a `.vsix` file is not checked.** It comes without a signature to check it against, as in VS Code.
- **Every build is tested on a real extension.** The build installs one through the app's own command line and stops if it is refused, the test that would have caught this.

### The agent can draw

Ask how something works and the agent can answer with a picture. Flows, architectures, decision trees and state machines come out as a diagram in the chat. They are laid out, labelled and drawn in your editor's theme.

- **Boxes link to code.** A box that names a function or a file opens it at the right line when clicked.
- **Full size and export.** **Full size** opens a zoomable view; **Esc** closes it. The toolbar copies the source, saves SVG or PNG, opens the diagram as Mermaid, or inserts it into a Markdown file.
- **Diagrams stay in the session.** A resumed session shows them again. After **Compact**, the agent can still fetch an old diagram by its id.
- **Screen readers get a text outline** of every diagram, and linked boxes open with Enter or Space.
- **It costs about 970 tokens a request** while it is on: the tool and its rules travel with every request. Turn it off with `levelcode.ai.diagrams.enabled`.

### Gemini 4 Argon, and room for reasoning models to think

Gemini 4 Argon is in the model picker on Pro plans, at about 100 turns a month at Google's introductory price. That part is on our side, so it does not wait for this release. v1.4.0 makes the editor handle it properly:

- **Its real window.** It gets its full 1,048,576 tokens of context, image input and the reasoning label in the picker. Before, a generic Gemini rule gave it 1,000,000.
- **A medium reasoning effort for chat and the agent**, and a low one for Compact, so it does not think at length about a summary.
- **Room to answer.** A reasoning model's thinking comes out of the same budget as its answer, so the agent now gives every reasoning model 32,768 tokens a turn instead of the 8,192 default. That covers Argon, Kimi K3 and the OpenAI o-series. Compact gives them 8,192 tokens instead of 1,500, which their thinking alone could use up, leaving an empty summary.

## New settings

- `levelcode.ai.diagrams.enabled` (default **on**): let the agent draw diagrams in the chat.

## New commands

- **AI: Diagram Statistics**: how the agent's diagrams have gone on this machine (drawn, repaired, fallen back, exported). Kept in the editor's own storage; nothing is sent anywhere.

## Also fixed

- **A finished answer is no longer nudged to continue.** An answer whose last line was a Markdown-formatted **Done:** did not end the run, and the agent was asked to keep going.
- **Three backticks inside a sentence** no longer break the paragraph into one line per streamed fragment.
- **A command that prints a lot tells the agent how it ended.** Output over 8,000 characters used to be cut from the end, which is where the failure and the exit code are. Now the agent sees the start and the end, with the gap stated.
- **Output over 256 KiB** is shown from its real start, and the count of what was left out is true.
- **A server that logs more than 100,000 characters before "listening on…"** is still seen as listening. Its port and its preview no longer go missing once the command's card is full.
- **The Welcome page and the Customize panel use the site's words.** The Welcome page now opens with the site's own line, and the customization extension is now called **LevelCode Customization**. Its settings and commands are unchanged.

## Not in this release

**LevelCode in a browser tab is not something you can use yet.** Its source is part of this release (`web/`, with a simulated shell for the agent), but it is not hosted anywhere. The Mac app is unchanged by it apart from the shared code it reorganized. That code was run in the real editor, against a stand-in model, before tagging: file writes, review, Undo, commands and diagrams.

**Diagrams have not yet been drawn by every model.** They were tested with scripted models, in the chat page and in the real editor. If a model draws badly, `levelcode.ai.diagrams.enabled` turns them off. Tell us which model it was.

**Gemini 4 Argon's reasoning is not carried from one agent step to the next.** The editor does not send it back, and Argon was checked to work without it, but a long task may be less consistent than it would be with it. Carrying it is real adapter work, planned separately.

**The Sessions panel still does not search.** It has been the stated gap since v1.0.5, and it still is.

**There is still no Windows or Linux build.**

## Test coverage

- **126 test files** run in the gate: the bundled extensions, the signature checker and the browser edition.
- **The bundled extensions' 70 suites hold 1,252 counted cases**, up from 49 suites and 892 cases in v1.3.1. Six suites print `N passing` and are not counted.
- `extensionSignature` (59 cases): the checker against real Open VSX packages and signatures, every way a signature can fail to verify, and a sweep showing a changed byte of the signature is always refused.
- The diagram suites (12): the schema and validator, the repair ladder, the layout, the painter, the text forms, the session replay and the host's export checks.
- `agentReasoningBudget` and `compactReasoningHost`: run the real agent loop and the real Compact, and read what each request asked for.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.3.1...v1.4.0
