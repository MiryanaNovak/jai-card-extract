# JanitorAI Card Extract

A Chrome extension that adds an **Extract** button to JanitorAI bot pages. One click saves the bot as a PNG character card that you can import into another chat app. The card holds the bot's picture, definition, greetings, lorebooks and the description written for users.

## Why this exists

I made this extractor to move bots from JanitorAI into [Reality Later](https://github.com/MiryanaNovak/reality-later), my self-hosted roleplay app. It isn't tied to Reality Later, though. The cards it saves use the standard character card format (V2 and V3), so they work in any app that imports character cards, such as SillyTavern.

## What it extracts

- **Picture.** The bot's avatar becomes the card's image. The original upload is used when JanitorAI has it, and it's converted to PNG, so an animated avatar becomes a still image.
- **Both names.** A JanitorAI bot has a **title** shown on its page (for example "Aveline | the archivist") and a **character name** the AI uses in chat (for example "Aveline"). Both are saved. The title goes in the V3 `name` field and the character name in `nickname`. V2 has room for only one name, so it gets the character name, which keeps `{{char}}` correct in apps that only read V2.
- **Definition.** JanitorAI's "Personality" field is the text the AI reads. It goes in the card's `description` field.
- **Scenario**, saved in `scenario`.
- **Example dialogs**, saved in `mes_example`.
- **Greetings.** The first message goes in `first_mes` and the others in `alternate_greetings`. Each greeting is saved once, even when JanitorAI sends duplicates.
- **Description for users.** The bot page description is saved in `creator_notes`, the field meant for people rather than the AI. It's converted from HTML to Markdown, which is much easier to edit:
  - Kept: headings, bold, italics, lists, links, quotes, tables, strikethrough and line breaks.
  - Dropped: colors, fonts, alignment and other CSS, which Markdown can't express.
  - Embedded videos and audio become links. Collapsible sections become a bold title followed by their text.
- **Pictures in the description.** Every image in the description is downloaded and embedded in the card, whether it's an HTML image, a Markdown image or a CSS background. Embedded images keep working after the original links die, and they still show in apps that block pictures from other websites.
- **Lorebooks.** Public lorebooks are saved in the card's `character_book`, with their keywords, secondary keywords, always-on entries, priorities and order. A card holds a single lorebook, so a bot with several gets one merged lorebook named "*title* lorebook". A bot with only one lorebook keeps its name.
- **Tags and creator**, saved in `tags` and `creator`.
- **Source.** A link to the bot page and its JanitorAI id are kept in the card, in `source` and `extensions.janitorai`.

The extension also cleans up what JanitorAI sends:

- **Watermarks.** JanitorAI adds a line such as "Created by someone 2026© on jani.com" to the end of the fields the AI reads. The extension removes it from the definition, scenario, example dialogs, greetings and lorebook entries, including when it's stuck onto the last sentence. A line is removed only when it's at the very end of a field, starts with "Created by", "©" or a year followed by "©", and names JanitorAI's site or the bot's creator. So a sentence such as "{{char}} was created by Dr. Vale" stays. In the description for users, only lines naming JanitorAI's site are removed, so a creator's own signature stays.
- **Duplicate greetings.** JanitorAI sometimes sends the first greeting twice, once with the watermark and once without. Only one copy is kept.

The saved file is named after the bot's title (*title*.png). The PNG holds the card twice: as V3 in its `ccv3` chunk and as V2 in its `chara` chunk. Apps that read V3, Reality Later included, use that version and get both names. Others use the V2 version.

## Private and missing elements

The extension only reads what JanitorAI sends to your browser while you're signed in. It doesn't try to get around a creator's privacy settings. When something is missing, the card is still saved with everything else, and the note above the button lists what was left out.

- **Hidden definition.** When a creator hides a bot's definition, JanitorAI doesn't send the hidden fields, so they're empty in the card. The note warns that the definition was hidden.
- **Private lorebooks** are skipped, and the note says how many. The bot's public lorebooks are still saved.
- **Description pictures that can't be downloaded**, for example because their host deleted them, keep their original link, and the note says how many. Some apps remove pictures that load from other websites, Reality Later included, so these won't show there.
- **An avatar that can't be downloaded** is replaced by a placeholder picture showing the character's initial.

## Installation

The extension works in Chrome. Other Chromium-based browsers, such as Edge or Brave, should work the same way but haven't been tested. Firefox isn't supported.

1. **Download it.** At the top of this page, click **Code**, then **Download ZIP**.
2. **Unzip it somewhere permanent**, such as a "Chrome extensions" folder in your Documents. Chrome can't install the zip directly: it must be unzipped.
3. **Open the extensions page.** Type `chrome://extensions` in the address bar (in Edge, `edge://extensions`) and turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the folder that contains `manifest.json`.

> [!IMPORTANT]
> **Keep the folder.** Chrome doesn't copy an unpacked extension anywhere. It reads the extension from this folder each time it starts. If you delete or move the folder, the extension stops working, at the latest the next time Chrome restarts. To move it, remove the extension from `chrome://extensions` and load it again from the new location.

**To update**, replace the folder's contents with the new version, then click the reload icon on the extension's card in `chrome://extensions`.

## Usage

1. Sign in to JanitorAI and open a bot's page, on janitorai.com or jani.com, its backup address.
2. Click **Extract** in the bottom-right corner.
3. The card is saved to your downloads folder. A note above the button shows the bot's two names, what was saved and anything that was left out.

Then import the PNG into your chat app.

## Permissions and privacy

- The Extract button only appears on janitorai.com and jani.com.
- The extension asks to access all websites. It needs this only to download the pictures in a bot's description, which creators host on many sites, such as imgur or catbox, that a web page isn't allowed to read. It downloads only the pictures of the bot you're extracting.
- The bot is read using your own JanitorAI session, the same way the site reads it.
- Nothing is sent anywhere else. There's no tracking and no code loaded from outside the extension.

## For developers

The extension is plain JavaScript with no build step: edit the files, then reload the extension.

| File | What it does |
|---|---|
| `src/core.js` | Maps JanitorAI's fields to the card, removes watermarks and duplicate greetings, converts lorebooks, finds description pictures and writes the PNG |
| `src/markdown.js` | Converts the description from HTML to Markdown |
| `src/content.js` | Adds the button and reads the bot from JanitorAI |
| `src/background.js` | Downloads pictures |
| `src/vendor/` | [markdown-it](https://github.com/markdown-it/markdown-it) and [Turndown](https://github.com/mixmark-io/turndown), both under the MIT license |

`src/core.js` and `src/markdown.js` also run in Node.js, where they're covered by tests. `npm install` is only needed for the tests (tested with Node.js 22):

```sh
npm install
npm test
```

## Acknowledgments

- [erpocalypse/jai-card-extractor](https://github.com/erpocalypse/jai-card-extractor), which showed how to read bots and lorebooks from JanitorAI's API.
- [markdown-it](https://github.com/markdown-it/markdown-it) and [Turndown](https://github.com/mixmark-io/turndown), which convert the description to Markdown.

This project isn't affiliated with JanitorAI. It's meant for backing up and moving bots: respect their creators' work and JanitorAI's terms.
