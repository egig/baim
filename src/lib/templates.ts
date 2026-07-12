import { convertFileSrc } from "@tauri-apps/api/core";
import type { Template } from "./tauri";

/** A predefined generation template the user can pick instead of typing a prompt
 *  by hand. Selecting one (or several) drives a batch of variants, each using the
 *  template's `prompt` verbatim. */
export interface GenerationTemplate {
  id: string;
  name: string;
  /** Preview image URL (served from `public/`). Empty falls back to a
   *  placeholder box in the UI. */
  imagePreview: string;
  prompt: string;
}

/** A template as rendered in `TemplatePicker`, whichever origin it came from.
 *  `isBuiltIn` gates whether rename/delete affordances apply — built-ins ship
 *  with the app and aren't user-editable. */
export interface PickerTemplate {
  id: string;
  name: string;
  imagePreview: string;
  prompt: string;
  isBuiltIn: boolean;
}

/** Combine user-saved templates with the built-in catalog into one list for
 *  `TemplatePicker` to render and `index.tsx` to resolve selections against.
 *  Saved templates come first (most-recently-created, per `templatesQuery`). */
export function mergeTemplates(saved: Template[]): PickerTemplate[] {
  return [
    ...saved.map((t) => ({
      id: t.id,
      name: t.name,
      imagePreview: convertFileSrc(t.preview_path),
      prompt: t.prompt,
      isBuiltIn: false,
    })),
    ...GENERATION_TEMPLATES.map((t) => ({ ...t, isBuiltIn: true })),
  ];
}

export const GENERATION_TEMPLATES: GenerationTemplate[] = [
  {
    id: "full-product-photo",
    name: "Full product photo",
    imagePreview: "/img/gamis-full.png",
    prompt:
      "A professional e-commerce product fashion photograph of an Indonesian woman, 155cm tall and weight 70kg with a realistic midsize/curvy build. The shot is cropped from the neck down to toe to be faceless, focusing on the clothing. Elegant, confident, and improved upright posture. Clean, minimalist light gray background, soft studio lighting, mid-end commercial fashion catalog style, squared 1k resolution.",
  },
  {
    id: "flat-lay",
    name: "Flat-lay",
    imagePreview: "/img/gamis-flatlay.png",
    prompt:
      "Professional e-commerce flat lay photography of a complete women's fashion outfit. The clothes are neatly arranged unfolded a clean, solid light gray background. Studio lighting, top-down knolling photography style, crisp details on fabric texture, no wrinkles, mid-end apparel catalog look, square image 1k resolution, sharp focus.",
  },
];
