/**
 * To do's context filters and grouping, remembered on this device
 * (views/loops.ts reads and writes them; ⌘K's "To do: Errands" sets them).
 */

import type { ContextFilter } from "../../../lib/todo-context";

export type GroupBy = "due" | "area" | "where";

export interface TodoView {
  area: ContextFilter;
  where: ContextFilter;
  group: GroupBy;
}

const VIEW_KEY = "athena.todo.view";

export function readTodoView(): TodoView {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Partial<TodoView>;
    return { area: v.area ?? null, where: v.where ?? null, group: v.group === "area" || v.group === "where" ? v.group : "due" };
  } catch {
    return { area: null, where: null, group: "due" };
  }
}

export function writeTodoView(v: TodoView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    // private mode: remembered until reload
  }
}
