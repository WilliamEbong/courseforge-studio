# Product

<!-- impeccable:product-schema 1 -->

> Written without an interview. The owner asked for an unattended build ("you make the judgement calls"). Facts marked *(inferred)* come from the brief and the repository, not from a confirmed answer.

## Platform

web

(It runs as a Windows desktop app: an Electron window around a local web editor.)

## Users
- **Instructional designers and e-learning developers** who build compliance, onboarding and skills courses. They now use (or can't afford) desktop authoring tools such as Storyline and Rise *(inferred)*.
- **Subject-matter experts** who need a course from a document, a policy or a brief, and have no authoring background *(inferred)*.
- **The owner, William Ebong**, who builds courses for clients and demos. He uses Claude Code daily.

## Product Purpose
CourseForge Studio is a local, offline-first course authoring app. Authors build slide courses (states, layers, triggers, variables, quizzes) or scrolling lessons courses, and publish them to Web or SCORM 1.2 for any LMS. Claude, through the author's own Claude subscription, drafts courses from a brief or document, and reviews and fixes them on request. Every AI change arrives as a preview the author applies or discards. Success: a credible, accessible course published to an LMS in an afternoon, without a terminal.

## Positioning
- A desktop authoring tool where AI edits through the same undoable commands as the author. The AI never writes behind the author's back: it proposes a change card, and Apply is one undo step.
- Free and open source (MIT), with no account or cloud. Courses are plain files in Documents.

## Operating Context
- Windows 10/11 laptops, often in an office. Long editing sessions at 1280–1920 px wide.
- Courses come from Word/PDF policies, slide decks and SME notes.
- Output goes to Moodle and other SCORM 1.2 LMSs, or to an offline web folder.
- Claude Code CLI installed and signed in on the same machine (for AI features).

## Capabilities and Constraints
- **Slides mode:** scenes, slides, objects (text, shape, button, image, hotspot, input, slider, dial, video, audio, marker), states, layers, triggers with conditions, variables, timeline and animations.
- **Quizzes:** 8 question types, banks and draws, results slides with Retry and Review.
- **Lessons mode:** 21 block types.
- **Themes:** 6 presets plus fonts.
- **Accessibility check** and Preview.
- **Publish:** Web, SCORM 1.2, PPTX, question files. .story import and export.
- **Other ways in:** command line (`cf`), MCP server for agents, local HTTP API. One command registry behind all of them.
- **AI:** the Claude Code CLI on the user's sign-in. Off until enabled; daily request limit. No API-key option yet (planned).
- **Unsigned installer:** Windows SmartScreen warns once.

## Brand Commitments
- Name: **CourseForge Studio**.
- Never present the product as a copy of another vendor's tool. Compatibility with the .story format may be stated as a fact.
- Voice: plain, direct, calm. Errors say what happened and what to do next.

## Evidence on Hand
- Two original demo courses: `samples/lab-safety.course.json` (slides) and `samples/lab-basics-lessons.course.json` (lessons), with original SVG assets.
- An original SVG image library: `packages/library` (31 images).
- No testimonials, customers or usage numbers exist; none may be invented.

## Product Principles
1. The author stays in charge: AI proposes, the author applies, Undo always works.
2. Nothing is lost: autosave, history and recovery.
3. Familiar where it matters: standard authoring patterns, standard controls.
4. Local and private by default: no account, no telemetry, AI only when switched on.

## Accessibility & Inclusion
WCAG 2.2 AA for the editor and for published courses. axe must report zero serious or critical issues. Every feature is reachable by keyboard.
