// The list of saves that haven't reached Athena yet, shared by the popup and options page.
import { send } from "./icons.js";

const KIND = { page: "Page", selection: "Quote", image: "Image", link: "Link", note: "Note" };

export function renderOutbox({ wrap, list, count, jobs, onChange }) {
  wrap.hidden = jobs.length === 0;
  if (!jobs.length) return;
  count.textContent = jobs.length === 1 ? "1 save waiting to send" : `${jobs.length} saves waiting to send`;
  list.replaceChildren(
    ...jobs.map((job) => {
      const li = document.createElement("li");
      const what = document.createElement("div");
      what.className = "what";
      const b = document.createElement("b");
      b.textContent = `${KIND[job.kind] || "Save"}: ${job.title || job.payload?.url || ""}`;
      const why = document.createElement("span");
      why.className = "meta";
      why.textContent =
        job.status === "held"
          ? job.error?.message || "Waiting for you."
          : `${job.error?.message || "Waiting to send."} Next try ${when(job.nextAt)}.`;
      what.append(b, why);
      const actions = document.createElement("div");
      actions.className = "actions";
      const retry = button("Retry", async () => {
        await send("retry", { id: job.id });
        onChange();
      });
      // Two clicks, since a removed save never reaches Athena (no confirm() in Firefox popups).
      const remove = button("Remove", async () => {
        if (remove.dataset.armed !== "1") {
          remove.dataset.armed = "1";
          remove.textContent = "Remove it?";
          return;
        }
        await send("dismiss", { id: job.id });
        onChange();
      });
      actions.append(retry, remove);
      li.append(what, actions);
      return li;
    }),
  );
}

function button(text, onclick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-quiet";
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

function when(at) {
  const secs = Math.round(((at ?? Date.now()) - Date.now()) / 1000);
  if (secs <= 30) return "in a moment";
  if (secs < 90) return "in a minute";
  const mins = Math.round(secs / 60);
  return mins < 60 ? `in ${mins} minutes` : "within the hour";
}
