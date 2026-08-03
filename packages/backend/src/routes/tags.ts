import { Hono } from "hono";
import { listTags } from "../services/tag.service";

const tags = new Hono();

// All tags with usage counts — feeds tag filter suggestions and autocomplete.
tags.get("/", (c) => {
  return c.json({ success: true, data: listTags() });
});

export { tags };
