import { useState } from "react";
import { formatTimecode } from "../lib/time.js";

export function CommentSidebar({
  comments,
  selectedCommentId,
  onCommentSelect,
  onCommentEdit,
  onCommentDelete,
  onToggleResolved,
  onCommentDrawerOpen,
  currentReviewer,
  canModifyComment = () => true,
  canResolve = true
}) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState("");

  function startEditing(comment) {
    setEditingId(comment.id);
    setDraft(comment.text);
  }

  function saveEditing(commentId) {
    onCommentEdit(commentId, draft);
    setEditingId(null);
    setDraft("");
  }

  function cancelEditing() {
    setEditingId(null);
    setDraft("");
  }

  return (
    <aside className="comment-sidebar" aria-label="Timestamp comments">
      <div className="sidebar-header">
        <div>
          <p className="eyebrow">Review Notes</p>
          <h2>Timestamp comments</h2>
        </div>
        <span>{comments.length}</span>
      </div>

      <div className="comment-list">
        {comments.length === 0 && (
          <div className="empty-state">
            <strong>No notes on this version yet.</strong>
            <p>Timestamp review notes will appear here.</p>
          </div>
        )}

        {comments.map((comment) => {
          const isSelected = comment.id === selectedCommentId;
          const isEditing = editingId === comment.id;
          const canModify = canModifyComment(comment);

          return (
            <article
              className={`comment-card${isSelected ? " selected" : ""}`}
              key={comment.id}
            >
              <button
                type="button"
                className="comment-main"
                onClick={() => {
                  onCommentSelect(comment, { autoplay: false });
                  if (isMobileViewport()) {
                    onCommentDrawerOpen?.(comment);
                  }
                }}
              >
                <span className="timecode">{formatTimecode(comment.time)}</span>
                <span className="comment-author">
                  {comment.author}
                  {comment.author === currentReviewer && !comment.submitted ? " · draft" : ""}
                </span>
              </button>

              {isEditing ? (
                <div className="comment-editor">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <div className="comment-actions">
                    <button type="button" onClick={() => saveEditing(comment.id)}>
                      Save
                    </button>
                    <button type="button" onClick={cancelEditing}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="comment-text">{comment.text}</p>
              )}

              <div className="comment-actions">
                <button
                  type="button"
                  disabled={!canModify}
                  onClick={() => startEditing(comment)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={!canModify}
                  onClick={() => onCommentDelete(comment.id)}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className={`resolve-toggle${comment.resolved ? " resolved" : ""}`}
                  disabled={!canResolve}
                  onClick={() => onToggleResolved(comment.id)}
                >
                  {comment.resolved ? "Resolved" : "Unresolved"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </aside>
  );
}

function isMobileViewport() {
  return window.matchMedia?.("(max-width: 768px)")?.matches || window.innerWidth <= 768;
}
