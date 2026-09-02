import { convertFileSrc } from "@tauri-apps/api/core";
import type { Template } from "./tauri";

/** A template as rendered in `TemplatePicker`: a saved `Template` row with
 *  its `preview_path` resolved to a displayable asset URL. All templates —
 *  including the two starter ones seeded server-side — are regular DB rows,
 *  so there's no built-in/user distinction to track here. `imagePreview` is
 *  `""` for templates created without a preview image (Templat page); callers
 *  fall back to a placeholder icon. */
export interface PickerTemplate {
  id: string;
  name: string;
  imagePreview: string;
  prompt: string;
}

export function toPickerTemplates(templates: Template[]): PickerTemplate[] {
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    imagePreview: t.preview_path ? convertFileSrc(t.preview_path) : "",
    prompt: t.prompt,
  }));
}
