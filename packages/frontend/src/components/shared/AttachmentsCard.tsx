import { Clock, Download, FileText, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";
import { type AttachmentRecord, api } from "@/api/client";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/i18n";
import { formatApiError } from "@/lib/format-api-error";
import { cn } from "@/lib/utils";

export interface AttachmentsCardHandle {
  /** Uploads anything picked before the record existed. */
  flush: (entityId: string) => Promise<void>;
  hasPending: () => boolean;
}

interface Props {
  entityType: "expense" | "invoice" | "customer";
  /**
   * null while the record is still unsaved. Files picked in that state are
   * held locally and uploaded by the parent via `flush` once an id exists —
   * attaching a receipt shouldn't require saving and reopening first.
   */
  entityId: string | null;
  /** Rendered above the list; defaults to a generic "Attachments" heading. */
  title?: string;
  description?: string;
  ref?: Ref<AttachmentsCardHandle>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentsCard({ entityType, entityId, title, description, ref }: Props) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<AttachmentRecord[]>([]);
  const [pending, setPending] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!entityId) return;
    try {
      const res = await api.listAttachments(entityType, entityId);
      setFiles(res.data ?? []);
    } catch (err) {
      toast.error(formatApiError(err, t));
    }
  }, [entityType, entityId, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Uploads to a known id; returns how many failed. */
  const sendToServer = async (targetId: string, list: File[]): Promise<number> => {
    let failed = 0;
    // One at a time so a single rejected file doesn't take the batch with it.
    for (const file of list) {
      try {
        await api.uploadAttachment(entityType, targetId, file);
      } catch (err) {
        failed++;
        toast.error(`${file.name}: ${formatApiError(err, t)}`);
      }
    }
    return failed;
  };

  useImperativeHandle(ref, () => ({
    flush: async (newEntityId: string) => {
      if (pending.length === 0) return;
      await sendToServer(newEntityId, pending);
      setPending([]);
    },
    hasPending: () => pending.length > 0,
  }));

  const uploadFiles = async (selected: FileList | File[]) => {
    const list = Array.from(selected);
    if (list.length === 0) return;

    // Nothing to attach to yet — hold them until the parent saves.
    if (!entityId) {
      setPending((current) => [...current, ...list]);
      return;
    }

    setUploading(true);
    const failed = await sendToServer(entityId, list);
    setUploading(false);

    const succeeded = list.length - failed;
    if (succeeded > 0) {
      toast.success(t("attachments.uploaded", { count: String(succeeded) }));
    }
    await refresh();
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteAttachment(id);
      await refresh();
    } catch (err) {
      toast.error(formatApiError(err, t));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Paperclip className="h-4 w-4" />
            {title ?? t("attachments.title")}
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-3">
          {pending.length > 0 && (
            <ul className="divide-y rounded-lg border border-dashed">
              {pending.map((file, index) => (
                <li
                  key={`${file.name}-${file.size}-${index}`}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(file.size)} · {t("attachments.pending")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setPending((c) => c.filter((_, i) => i !== index))}
                    aria-label={t("common.delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {files.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {files.map((file) => (
                <li key={file.id} className="flex items-center gap-3 px-3 py-2">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{file.file_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(file.bytes)} · {new Date(file.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <a
                    href={api.attachmentDownloadUrl(file.id)}
                    download={file.file_name}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm hover:bg-muted"
                  >
                    <Download className="h-4 w-4" />
                    <span className="sr-only">{t("common.download")}</span>
                  </a>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDeletingId(file.id)}
                    aria-label={t("common.delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the nested button is the keyboard path */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              uploadFiles(e.dataTransfer.files);
            }}
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors",
              dragging ? "border-primary bg-primary/5" : "border-border",
            )}
          >
            <Upload className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("attachments.drop_hint")}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
            >
              {uploading && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("attachments.choose_files")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {entityId ? t("attachments.accepted_types") : t("attachments.pending_hint")}
            </p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.tif,.tiff,.xml"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) uploadFiles(e.target.files);
                // Allow re-selecting the same file after a failed upload.
                e.target.value = "";
              }}
            />
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!deletingId}
        onOpenChange={(open) => !open && setDeletingId(null)}
        title={t("attachments.delete_title")}
        description={t("attachments.delete_hint")}
        confirmLabel={t("common.delete")}
        variant="destructive"
        onConfirm={() => {
          if (deletingId) return handleDelete(deletingId);
        }}
      />
    </>
  );
}
