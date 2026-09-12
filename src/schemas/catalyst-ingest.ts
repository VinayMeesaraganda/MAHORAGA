/**
 * Schema for catalysts pushed in from outside the Worker.
 *
 * These become entry permissions, so the payload is validated as strictly as
 * model output is: an unvalidated push would be a way to bypass the gate that
 * decides whether a trade may happen at all.
 */

import { z } from "zod";

export const IngestedCatalystSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .regex(/^[A-Za-z.-]+$/, "symbol must be a plain ticker"),
  type: z.enum([
    "guidance",
    "regulatory",
    "earnings",
    "contract",
    "m_and_a",
    "partnership",
    "product",
    "analyst",
    "theme",
    "squeeze",
  ]),
  quality: z.enum(["low", "medium", "high"]),
  headline: z.string().trim().min(1).max(300),
  /** ISO timestamp of the event, not of the push. */
  at: z.string().trim().min(1),
});

export const IngestedCatalystsSchema = z.object({
  catalysts: z.array(IngestedCatalystSchema).max(200),
});

export type IngestedCatalyst = z.infer<typeof IngestedCatalystSchema>;
