# Euphonium Follower

Sheet music that listens to your euphonium. It loads MusicXML, draws it with
[OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/), listens through the browser microphone,
detects pitch with YIN, follows your place in the music, highlights the current note and turns pages for you.

All audio processing happens in your browser. No audio is uploaded, there's no account, and there's no server-side code.

## Run it

The microphone only works on a secure page (`https://` or `http://localhost`).

```powershell
node serve.mjs        # then open http://localhost:8000
```

Any static file server works too. To use it on a tablet or phone for free, push this folder to a GitHub repo and turn on
**GitHub Pages** (Settings → Pages → deploy from branch). You get an `https://` address with no build step.
You need internet on first load, because OpenSheetMusicDisplay and JSZip come from a CDN.

## Getting your music in

1. **PDF → MusicXML** with [Audiveris](https://audiveris.github.io/) (Book → Export → MusicXML).
2. **Clean up in MuseScore**: fix wrong notes, ties and missing accidentals. The follower only knows what's in the file.
   Delete stray voices or chords that Audiveris invents. The follower uses the highest note at each moment.
3. **File → Export → MusicXML** (`.musicxml` or compressed `.mxl`; both work).
4. Open it with **Open score**, drag it onto the window, or link to it as `index.html?score=path/to/piece.musicxml`.

### Treble clef or bass clef?

The detector hears **concert pitch**, so the app has to know how your part is written. **Written in → Auto** decides like this:

| What's in the file | Auto treats it as |
|---|---|
| A `<transpose>` element (MuseScore adds this when the instrument is *Euphonium (treble)* or *Baritone (treble)*) | Uses the file's value (normally −14) |
| Treble clef, no `<transpose>` (typical Audiveris output of brass-band parts) | B♭ treble clef: sounds a major 9th lower (−14) |
| Bass or tenor clef | Concert pitch (0) |

If Auto gets it wrong, pick the setting by hand. One case to watch: a **concert-pitch bass-clef part that is entirely in treble
clef** is unusual, but would be guessed wrong. Choose *Concert pitch* for it. The tuner in the toolbar shows the
**written** note name (and the concert name for treble parts), so you can check the setting by playing one note.

## Using it

- Press **Listen** (or Space) and play from the highlighted note. Click any note to start from there.
- **Page turns** mode jumps a screen at a time when you start the last fully visible line, so you can always read ahead.
  The other option waits until the music actually runs off the screen. **Continuous scroll** keeps the current line near the top.
- **Mic sensitivity** (⚙): the yellow mark on the level meter is the threshold. Room noise should stay to its left
  and your playing should go well past it.
- Keys: ←/→ one note · Home back to the start · PgUp/PgDn manual turn · F full screen.
- The screen is kept awake while listening (where the browser supports it).

### How the following works

- **Pitch**: an AudioWorklet decimates the mic signal to ~24 kHz and sends 1024-sample frames every ~10 ms. YIN
  (45–1000 Hz) runs on each frame. That covers pedal B♭1 (58 Hz) through B♭5 (932 Hz). Echo cancellation, noise
  suppression and auto gain are turned off because they distort music.
- **Notes**: a pitch must hold for about 45 ms to count. A repeated note is detected from the volume dip when you tongue it.
- **Matching**: each new note is matched against the next few notes in the score. Skipping a note, an octave error
  (typical in the low register) or a semitone slip each cost a little, so the follower carries on through small mistakes.
- **Getting lost**: after a couple of unmatched notes, or a run of poor matches, it looks for the last 3–4 notes you
  played anywhere in the piece and jumps there. This covers repeats and D.S./D.C. (the score isn't unrolled), and
  starting partway through without clicking.

### Limits

- It follows one melodic line. Chords in the part are reduced to their top note, and grace notes are ignored.
- Long rests aren't counted out. The follower waits on the next note, which is usually what you want.
- Loud accompaniment in the same room (piano, band) can confuse it. Point the mic at the bell and lower the sensitivity.
- Very fast passages (notes shorter than ~60 ms) may be partly skipped, but it catches up on the next held notes.

## Project layout

```
index.html            UI shell (OSMD 2.2.1 and JSZip 3.10.1 from CDN)
css/style.css
js/app.js             UI wiring, page turning, settings (localStorage)
js/score.js           MusicXML/.mxl loading, part + clef/transpose detection, OSMD render, note list, cursor
js/audio.js           getUserMedia → AudioWorklet → YIN
js/pitch-worklet.js   buffering + decimation on the audio thread
js/yin.js             YIN pitch detector (pure)
js/follower.js        onset detection + score matching (pure)
js/notes.js           pitch names, transposition presets
samples/              practice piece (bass clef)
tests/run-tests.mjs   Node tests on synthetic euphonium tones
tests/fixtures/       long treble-clef B♭ test piece (40 bars)
serve.mjs             zero-dependency local server
```

`npm test` (or `node tests/run-tests.mjs`) checks YIN accuracy from B♭1 to B♭5 and the follower's behaviour: a clean run,
skipped and wrong notes, starting mid-piece, the low and high registers, legato, held notes, repeats and room noise.
