import { useEffect } from 'react';

/**
 * Custom hook to set document title dynamically.
 * Automatically appends " | Closwiz" suffix.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | Closwiz`;

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
