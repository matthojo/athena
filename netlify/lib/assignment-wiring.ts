/**
 * Assignments' ports, wired once where a function starts (api, team-run,
 * reminders import this file): the runner posts to Team chat, settles its
 * posts, lists a note's made files and makes the finished document.
 * lib/assignment-run.ts imports none of these itself.
 */
import { configureAssignments } from "../../lib/assignment-run";
import { documentsForNote, makeDocument } from "../../lib/document-make-db";
import { postToTeam, settlePosts } from "../../lib/team-posts";

configureAssignments({
  post: (input) => postToTeam(input).then(() => undefined),
  settled: (ref) => settlePosts(ref).then(() => undefined),
  documentsFor: documentsForNote,
  makeDocument,
});
