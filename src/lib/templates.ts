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

export const GENERATION_TEMPLATES: GenerationTemplate[] = [
  {
    id: "full-product-photo",
    name: "Full product photo",
    imagePreview: "/img/gamis-full.png",
    prompt:
      "A professional e-commerce product fashion photograph of an Indonesian woman, 155cm tall and weight 70kg with a realistic midsize/curvy build. The shot is cropped from the neck down to be faceless, focusing on the clothing. Elegant, confident, and improved upright posture. Clean, minimalist light gray background, soft studio lighting, mid-end commercial fashion catalog style, 1k resolution.",
  },
  {
    id: "flat-lay",
    name: "Flat-lay",
    imagePreview: "/img/gamis-flatlay.png",
    prompt:
      "Professional e-commerce flat lay photography of a complete women's fashion outfit. The clothes are neatly arranged unfolded a clean, solid light gray background. Studio lighting, top-down knolling photography style, crisp details on fabric texture, no wrinkles, mid-end apparel catalog look, square image 1k resolution, sharp focus.",
  },
];
