use uuid::Uuid;

use crate::generation::{self, read_image_as_data_uri};
use crate::providers::openai_compatible::{self, ChatReply, ChatTurnInput};
use crate::registry::{ChatMessageRow, RegistryDb};

const SYSTEM_PROMPT: &str = "You are the AI assistant built into Baim, a desktop image browser. \
The user browses their filesystem in the app and can attach one or more image files to a message \
to you. You can generate an edited variant of an attached image via the `generate_image` tool: \
call it with a `prompt` describing the desired change, and it will be applied to the image attached \
to the user's most recent message. You cannot generate an image from nothing — if the user asks for \
an image but the latest message has no attachment, ask them to attach a source image first instead \
of calling the tool. You cannot rename, move, or delete files. Keep replies short.";

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A short text note standing in for an older turn's attachments, so history
/// still reads coherently without re-embedding every past image on every
/// call (see `send_message`).
fn attachment_note(paths: &[String]) -> String {
    let names: Vec<&str> = paths
        .iter()
        .map(|p| std::path::Path::new(p).file_name().and_then(|n| n.to_str()).unwrap_or(p.as_str()))
        .collect();
    format!("\n[attached: {}]", names.join(", "))
}

/// Build the wire-format turn list from the persisted thread. Only the most
/// recent user turn's attachments are actually re-embedded as image data —
/// earlier turns just note their filenames in text — so a long-running
/// conversation's payload doesn't balloon by resending every image on every
/// message.
fn build_turns(history: &[ChatMessageRow]) -> Vec<ChatTurnInput> {
    let last_user_idx = history.iter().rposition(|m| m.role == "user");

    let mut turns = vec![ChatTurnInput {
        role: "system".to_string(),
        text: SYSTEM_PROMPT.to_string(),
        image_data_uris: Vec::new(),
    }];

    for (i, m) in history.iter().enumerate() {
        let mut text = m.content.clone();
        let mut image_data_uris = Vec::new();
        if !m.attachments.is_empty() {
            if Some(i) == last_user_idx {
                for path in &m.attachments {
                    if let Ok(uri) = read_image_as_data_uri(path) {
                        image_data_uris.push(uri);
                    }
                }
            } else {
                text.push_str(&attachment_note(&m.attachments));
            }
        }
        turns.push(ChatTurnInput {
            role: m.role.clone(),
            text,
            image_data_uris,
        });
    }
    turns
}

/// Handle one chat turn: persist the user's message, call the model with the
/// full thread as context, and persist+return whatever it produced — either
/// a plain reply, or (via the `generate_image` tool) a triggered generation
/// whose live status the chat pane tracks through the normal generations
/// query. Returns just the newly-created rows (user turn + assistant turn),
/// not the whole thread.
pub async fn send_message(
    registry: &RegistryDb,
    text: String,
    attachments: Vec<String>,
) -> Result<Vec<ChatMessageRow>, String> {
    let user_turn = ChatMessageRow {
        id: Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: text,
        attachments,
        generation_id: None,
        created_at: now(),
    };
    registry.insert_chat_message(&user_turn)?;

    let api_key = registry
        .read_api_key("openai_compatible")
        .ok_or("Set up the OpenAI-compatible provider's Base URL, Model, and API key in Settings to use chat")?;

    let history = registry.list_chat_messages()?;
    let turns = build_turns(&history);

    let reply = openai_compatible::chat_complete(&api_key, &turns).await?;

    let assistant_turn = match reply {
        ChatReply::Text(text) => ChatMessageRow {
            id: Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content: text,
            attachments: Vec::new(),
            generation_id: None,
            created_at: now(),
        },
        ChatReply::ToolCall { name, arguments } if name == "generate_image" => {
            match trigger_generation(registry, &user_turn, &arguments) {
                Ok((content, generation_id)) => ChatMessageRow {
                    id: Uuid::new_v4().to_string(),
                    role: "assistant".to_string(),
                    content,
                    attachments: Vec::new(),
                    generation_id: Some(generation_id),
                    created_at: now(),
                },
                Err(err) => ChatMessageRow {
                    id: Uuid::new_v4().to_string(),
                    role: "assistant".to_string(),
                    content: err,
                    attachments: Vec::new(),
                    generation_id: None,
                    created_at: now(),
                },
            }
        }
        ChatReply::ToolCall { .. } => ChatMessageRow {
            id: Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content: "I don't have a way to do that yet.".to_string(),
            attachments: Vec::new(),
            generation_id: None,
            created_at: now(),
        },
    };
    registry.insert_chat_message(&assistant_turn)?;

    Ok(vec![user_turn, assistant_turn])
}

/// Resolve the `generate_image` tool call into an enqueued generation,
/// sourced from the triggering user turn's first attachment. Returns the
/// assistant-facing status text plus the new generation's id.
fn trigger_generation(
    registry: &RegistryDb,
    user_turn: &ChatMessageRow,
    arguments: &serde_json::Value,
) -> Result<(String, String), String> {
    let source_path = user_turn
        .attachments
        .first()
        .ok_or("Attach an image first — I can only generate a variant of an image you've attached.")?;
    let prompt = arguments
        .get("prompt")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or("The model didn't provide a prompt to generate with.")?;

    let image = generation::get_or_create_image(registry, source_path)?;
    let provider_id = registry.read_active_provider();
    let record = generation::create_prediction(registry, prompt, &provider_id, Some(&image.id), "interactions")?;

    Ok((format!("Generating: {}", prompt), record.id))
}

pub fn list_messages(registry: &RegistryDb) -> Result<Vec<ChatMessageRow>, String> {
    registry.list_chat_messages()
}
