import { APP_LOCALE } from "./locale";
import { EN_COPY } from "./locales/en";
import { ES_COPY } from "./locales/es";

export const COPY = APP_LOCALE === "es" ? ES_COPY : EN_COPY;

export type CopyKey = keyof typeof COPY;
