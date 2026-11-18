"use client";
import { createContext, useContext } from "react";
import { initialPipelineSettings, type PipelineSettings } from "@/lib/forecast";
export const PipelineContext = createContext<PipelineSettings>(
  initialPipelineSettings,
);
export const usePipelineCatalog = () => useContext(PipelineContext);
