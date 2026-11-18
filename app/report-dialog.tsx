"use client";
import {useEffect,useRef} from "react";
import {X} from "lucide-react";
export function Dialog({
  title,
  onClose,
  children,
  className,
  returnFocus = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  returnFocus?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog=ref.current;
    const opener=returnFocus&&document.activeElement instanceof HTMLElement?document.activeElement:null;
    dialog?.showModal();
    if(returnFocus)return ()=>{dialog?.close();if(opener?.isConnected)opener.focus();};
  }, [returnFocus]);
  return (
    <dialog
      ref={ref}
      className={["report-dialog",className].filter(Boolean).join(" ")}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button type="button" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
