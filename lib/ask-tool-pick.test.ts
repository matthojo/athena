import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetRefused, pickTools, questionWords, rememberRefused, toolFit, wasRefused } from "./ask-tool-pick";

const tool = (name: string, description = "") => ({ name, description });

test("a question's words: no stop words, plurals folded", () => {
  assert.deepEqual(questionWords("What is the current status of growth experiments?"), ["growth", "experiment"]);
  assert.deepEqual(questionWords("How's the Q4 launch going?"), ["launch", "going"]);
  assert.deepEqual(questionWords("is it?"), []);
});

test("a word in a tool's name counts three times one in its description", () => {
  const words = questionWords("status of growth experiments");
  assert.equal(toolFit(words, tool("experiment-get-all", "List experiments in the project")), 3);
  assert.equal(toolFit(words, tool("insights-list", "Insights, including ones about growth and each experiment")), 2);
  assert.equal(toolFit(words, tool("query-logs", "Search application logs")), 0);
});

test("an account with few tools offers them all; one with hundreds offers the ones that fit, in its own order", () => {
  const few = [tool("search"), tool("fetch")];
  assert.equal(pickTools("anything", few), few);
  const many = [
    tool("docs-search", "Search PostHog documentation"),
    ...Array.from({ length: 300 }, (_, i) => tool(`thing-${i}`, "Something else entirely")),
    tool("experiment-get-all", "List every experiment"),
    tool("experiment-results-get", "An experiment's results and status"),
    tool("feature-flag-get-all", "Flags, some tied to an experiment"),
  ];
  const picked = pickTools("What is the current status of growth experiments?", many, 6).map((t) => t.name);
  // The three that fit, and the front of the list to fill the rest: the service's usual tools come first there.
  assert.deepEqual(picked, ["docs-search", "thing-0", "thing-1", "experiment-get-all", "experiment-results-get", "feature-flag-get-all"]);
  // Nothing fits: the front of the list.
  assert.deepEqual(pickTools("the second one", many, 3).map((t) => t.name), ["docs-search", "thing-0", "thing-1"]);
});

test("a refused definition is remembered for the next question", () => {
  forgetRefused();
  assert.equal(wasRefused("posthog_personal__query-logs"), false);
  rememberRefused("posthog_personal__query-logs");
  assert.equal(wasRefused("posthog_personal__query-logs"), true);
  forgetRefused();
});
