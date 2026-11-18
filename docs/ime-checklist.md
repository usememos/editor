# Manual IME checklist

The browser tests in `e2e/ime.spec.ts` drive Chromium through the Chrome DevTools Protocol. In Chromium, Firefox and WebKit they also replay composition events with the last input arriving before or after `compositionend`. The native candidate window and operating-system keyboard still need a device check. Before a release, run this checklist by hand with real input methods.

## Setups

Run every check on each setup. Record pass or fail with the browser version.

| OS | Browser | Input methods |
| --- | --- | --- |
| macOS | Safari, Chrome, Firefox | Chinese Pinyin (Simplified), Japanese Kana (Romaji), Korean 2-Set |
| Windows 11 | Edge, Chrome, Firefox | Microsoft Pinyin, Microsoft IME (Japanese), Microsoft IME (Korean) |
| iOS | Safari | Pinyin, Japanese Romaji, Korean, English with autocorrect and dictation |
| Android | Chrome | Gboard with Pinyin, Japanese, Korean, and English with autocorrect |

Open the playground (`npm run dev`, then the "Empty" link) and watch the Markdown output under the editor. The output updates while you compose.

## Checks

The last column names the automated test that covers the same behavior in Chromium, if any. A covered check still needs a real device: the test proves the editor's handling, not the browser's or the keyboard's.

| # | Check | Automated in Chromium |
| --- | --- | --- |
| 1 | Type a full sentence and commit it. The output shows exactly the committed text. | a composition is one undo step |
| 2 | While composing, the candidate window appears next to the caret, the underlined composition text is visible, and the placeholder is gone. | Placeholder only (the model follows the composed text) |
| 3 | Compose in the middle of existing text. Text after the caret is not duplicated or lost. | composing in the middle of text |
| 4 | Compose inside bold text, and after Mod+B in an empty spot. The committed text is bold in the output. | composition inside bold text; marks chosen before composing |
| 5 | Select text across two paragraphs, then start composing. The selection is replaced and the two paragraphs join. | composition over a selection spanning blocks |
| 6 | Compose in an empty paragraph, a heading, a list item, a quote, a code block, and a table cell. | composition starting in an empty block; in a list item and a table cell; in a heading, a quote and a code block |
| 7 | Compose a word as the only text of an empty paragraph and commit it. The word is not selected afterwards, and the toolbar does not open. Korean: the second syllable does not replace the first. | a DOM range during composition input never reaches the model (WebKit order) |
| 8 | Korean: type a syllable, then a second one that takes the final consonant of the first (가, then ㄴ, then ㅏ). Both syllables are correct, and fast typing does not drop or double a syllable. | Korean: a syllable that takes the next consonant |
| 9 | Press Enter to commit a composition. No new block is created by that same Enter (on macOS Japanese, Enter commits; a second Enter splits). Repeat with the slash menu open: the commit does not pick an item. | Enter that commits a composition |
| 10 | Press Backspace during a composition. Only the composition text changes. | No (the keyboard handles it) |
| 11 | Undo right after a commit removes the committed text in one step. | a composition is one undo step |
| 12 | Japanese: type a full-width slash (`／`). The slash menu opens. Keep composing: the menu filters. | full-width slash; an open suggestion menu filters by the composed text |
| 13 | Select text: the formatting toolbar shows. Start composing: it hides. | the formatting toolbar hides while composing |
| 14 | Android: type with autocorrect on, accept a suggestion, then backspace through it. The output matches the screen. | autocorrect and word suggestions replace the word (events only) |
| 15 | Android: type a word and, while it is still underlined, tap Save. The saved text includes the word. | saving while composing keeps the composed text |
| 16 | Android: type `/` and then `tab` (underlined), then Enter. The table is inserted and no empty line is added. Repeat with `#` and a tag if the tag menu is on. | an open suggestion menu filters; Enter from a keyboard that sends keyCode 229 |
| 17 | iOS: type with autocorrect on (for example "teh "), and tap a QuickType suggestion. The output matches the screen. | autocorrect and word suggestions replace the word (events only) |
| 18 | iOS: use dictation for one sentence. The output matches the screen. | No |
| 19 | macOS: hold a letter key and pick an accented letter from the menu (é). The output shows only the accented letter. | No |
| 20 | Firefox: compose and commit a word with a candidate that differs from the reading (Japanese かんじ → 漢字). Undo removes it in one step. | the last input after compositionend (Firefox order, events only) |
| 21 | Japanese: type a full-width `＃` after a space. The tag popup opens. Pick a tag: the output has an ASCII `#`. | a full-width ＃ opens the popup and a pick writes # |
| 22 | Pinyin: type `#`, then `riji` and convert it to `日记`. The tag list stays shown while the reading is underlined, then shows `#日记`. | a reading that matches nothing keeps the list until it is converted |
| 23 | With the tag popup open, compose a word and commit it with Enter. The commit does not pick an item; a second Enter does. On Safari, also press the second Enter quickly. | the Enter that commits a composition does not pick |
| 24 | Android and iOS: with the tag popup open and a word still underlined, tap an item. The output has the picked tag once, and the underlined word is not added again. | a click on an item while composing commits the composed text once, then picks |
| 25 | Android: type `#wor` in a word that already exists (`#wor` then `k`, all underlined by the keyboard). The popup opens as you type. | composed text in a token opens the popup and filters it |
| 26 | Safari, Pinyin: in an empty paragraph, type a reading (`ceshi`) and pick a candidate with Space or a number. The output has the word picked (`测试`), not the reading. Then type a reading in another empty paragraph and delete it with Backspace: the paragraph stays empty. | the committed word replaces the reading; a composition deleted without a commit leaves the block empty (events only) |
| 27 | Japanese: convert a sentence with several clauses, select a clause in the middle, then commit and type another character. It appears after the committed sentence. | committing a Japanese clause selection leaves the caret after the word (Chromium CDP) |
| 28 | Compose in a table cell, click a paragraph, type more text, then save and reload. Both the composed word and the later text remain. | leaving an unfinished table composition keeps later typing in saved Markdown |
| 29 | In Markdown source mode, type 안녕하세요 at the end of a line, pause two seconds, commit and immediately type a space. Continue typing. Repeat with Japanese and Chinese candidates and in the middle of existing text. The space and the next character follow the committed word. | source mode inserts an immediate space; source mode keeps a space after the last committed Korean syllable |
| 30 | Select an existing Japanese word, including a backward selection, and start reconversion (Windows conversion key or macOS Kana twice). Pick a different candidate, type punctuation, then undo both edits. The original word and surrounding text return. | reconversion keeps a backward selection |
| 31 | In the link or image alt-text field, use Enter to confirm a candidate and Escape to dismiss the candidate list. The field keeps focus. A separate Enter applies the value and a separate Escape closes the field. | composition keys stay with the IME |

Some Chinese input methods type `、` on the slash key. The editor keeps it as punctuation. Enter `/` or `／` to open the slash menu.
