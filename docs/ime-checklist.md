# Manual IME checklist

Automated tests simulate IME input in Chromium only. Before a release, run this checklist by hand with real input methods.

## Setups

Run every check on each setup. Record pass or fail with the browser version.

| OS | Browser | Input methods |
| --- | --- | --- |
| macOS | Safari, Chrome, Firefox | Chinese Pinyin (Simplified), Japanese Kana (Romaji), Korean 2-Set |
| Windows 11 | Edge, Chrome, Firefox | Microsoft Pinyin, Microsoft IME (Japanese), Microsoft IME (Korean) |
| iOS | Safari | Pinyin, Japanese Romaji, Korean keyboards |
| Android | Chrome | Gboard with Pinyin, Japanese and Korean |

Open the playground (`npm run dev`, then the "Empty" link) and watch the Markdown output under the editor.

## Checks

1. Type a full sentence and commit it. The output shows exactly the committed text.
2. While composing, the candidate window appears next to the caret and the underlined composition text is visible.
3. Compose in the middle of existing text. Text after the caret is not duplicated or lost.
4. Compose inside bold text. The committed text is bold in the output.
5. Select text across two paragraphs, then start composing. The selection is replaced and the two paragraphs join.
6. Compose in an empty paragraph, in a list item, in a quote, in a code block, and in a table cell.
7. Korean: type a syllable, then a second one that takes the final consonant of the first (for example 가 then ㄴ then ㅏ). Both syllables are correct.
8. Press Enter to commit a composition. The text is committed and no new block is created by that same Enter (on macOS Japanese, Enter commits; a second Enter splits).
9. Press Backspace during a composition. Only the composition text changes.
10. Undo right after a commit removes the committed text in one step.
11. Japanese: type a full-width slash (`／`). The slash menu opens.
12. Select text and use the formatting toolbar: it is hidden while composing and returns after commit.
13. Android: type with autocorrect on, accept a suggestion, then backspace through it. The output matches what is on screen.
14. iOS: use dictation for one sentence. The output matches what is on screen.
