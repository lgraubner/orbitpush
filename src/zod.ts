import en from "zod/v4/locales/en.js";
import * as z from "zod/mini";

// zod/mini ships without error messages, so its issues would all read "Invalid input"
z.config(en());

export { z };
