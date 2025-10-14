'use client';

import { useCallback, useRef, useState } from "react";
import { Button } from "./ui/button";

type UploadDropzoneProps = {
  accept?: string;
  onFile: (file: File) => void;
};

export function UploadDropzone({ accept = ".csv,.xlsx,.xls", onFile }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setDragging] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      onFile(files[0]);
      setDragging(false);
    },
    [onFile]
  );

  return (
    <div
      className={`flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8 text-center transition hover:border-primary ${isDragging ? "bg-secondary/40" : "bg-muted/30"}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        handleFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => handleFiles(event.target.files)}
      />
      <p className="text-lg font-semibold">Drop a CSV or XLSX file</p>
      <p className="text-sm text-muted-foreground">Or click the button below to browse files</p>
      <Button
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        Choose file
      </Button>
    </div>
  );
}
