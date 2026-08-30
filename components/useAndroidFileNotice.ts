"use client";

import { useState } from "react";
import { isAndroid } from "@/lib/platform";

/**
 * There is no browser event for "the native file chooser failed to open" --
 * a tap either opens the OS picker or silently does nothing. This surfaces a
 * clear explanation the first time an Android user attempts to open the
 * picker, instead of leaving them staring at an input that appears to do
 * nothing.
 */
export function useAndroidFileNotice() {
  const [showAndroidNotice, setShowAndroidNotice] = useState(false);

  const notifyFilePickerAttempt = () => {
    if (!showAndroidNotice && isAndroid()) setShowAndroidNotice(true);
  };

  return { showAndroidNotice, notifyFilePickerAttempt };
}
