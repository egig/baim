use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct Prediction {
    id: String,
    status: String,
    output: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreatePredictionResponse {
    id: String,
    status: String,
    urls: PredictionUrls,
}

#[derive(Debug, Deserialize)]
struct PredictionUrls {
    get: String,
}

pub async fn generate_image(
    data_uri: &str,
    prompt: &str,
    api_key: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let model = "black-forest-labs/flux-dev";
    let payload = serde_json::json!({
        "input": {
            "prompt": prompt,
            "image": data_uri,
            "num_outputs": 1,
        }
    });

    let create_resp = client
        .post(format!(
            "https://api.replicate.com/v1/models/{}/predictions",
            model
        ))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .header("Prefer", "wait")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to create prediction: {}", e))?;

    if !create_resp.status().is_success() {
        let status = create_resp.status();
        let body = create_resp
            .text()
            .await
            .unwrap_or_else(|_| "unknown".to_string());
        if status == 402 {
            return Err("API quota exceeded or payment required".to_string());
        }
        return Err(format!("Replicate API error ({}): {}", status, body));
    }

    let create_data: CreatePredictionResponse = create_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let prediction = poll_prediction(&client, &create_data.urls.get, api_key).await?;

    if prediction.status == "succeeded" {
        let output = prediction.output.ok_or("No output from model")?;
        let image_url = output
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|v| v.as_str())
            .or_else(|| output.as_str())
            .ok_or("Unexpected output format")?
            .to_string();

        let images_dir = get_images_dir()?;
        let filename = format!("{}.png", uuid::Uuid::new_v4());
        let filepath = images_dir.join(&filename);

        let img_bytes = client
            .get(&image_url)
            .send()
            .await
            .map_err(|e| format!("Failed to download image: {}", e))?
            .bytes()
            .await
            .map_err(|e| format!("Failed to read image bytes: {}", e))?;

        std::fs::create_dir_all(&images_dir)
            .map_err(|e| format!("Failed to create images directory: {}", e))?;
        std::fs::write(&filepath, &img_bytes)
            .map_err(|e| format!("Failed to save image: {}", e))?;

        Ok(filepath.to_string_lossy().to_string())
    } else {
        let err_msg = prediction.error.unwrap_or_else(|| "Unknown error".into());
        Err(format!("Generation failed: {}", err_msg))
    }
}

async fn poll_prediction(
    client: &reqwest::Client,
    get_url: &str,
    api_key: &str,
) -> Result<Prediction, String> {
    let max_attempts = 60;
    for _ in 0..max_attempts {
        let resp = client
            .get(get_url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| format!("Failed to poll prediction: {}", e))?;

        let prediction: Prediction = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse prediction: {}", e))?;

        match prediction.status.as_str() {
            "succeeded" => return Ok(prediction),
            "failed" => return Ok(prediction),
            "canceled" => return Err("Generation was canceled".to_string()),
            _ => {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            }
        }
    }
    Err("Timed out waiting for generation".to_string())
}

fn get_images_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join("Pictures").join("catalog-gen"))
}

pub fn list_saved_images() -> Result<Vec<ImageEntry>, String> {
    let dir = get_images_dir()?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut entries = vec![];
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read images directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "png" || ext == "jpg" || ext == "jpeg")
                .unwrap_or(false)
        })
        .collect();

    paths.sort_by_key(|e| {
        std::cmp::Reverse(
            e.metadata()
                .and_then(|m| m.created())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        )
    });

    for entry in paths {
        let path = entry.path();
        let created = entry
            .metadata()
            .ok()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let size = entry
            .metadata()
            .ok()
            .map(|m| m.len())
            .unwrap_or(0);

        entries.push(ImageEntry {
            path: path.to_string_lossy().to_string(),
            filename: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            created_at: created,
            size_bytes: size,
        });
    }

    Ok(entries)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImageEntry {
    pub path: String,
    pub filename: String,
    pub created_at: i64,
    pub size_bytes: u64,
}
