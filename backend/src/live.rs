//! WebSocket 实时通道（对齐 lib/live.cjs）。
//!
//! 端点 /api/ws?role=screen|admin[&name=屏名]。
//! 三类广播语义：config-changed / control / clients；
//! 连接/断开/心跳/screen-status 均触发 clients 列表广播。
//! 消息格式：服务端 → 客户端统一 { type, data }。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::config::now_ms;
use crate::iputil::local_lan_ipv4;
use crate::state::AppState;

/// 进入写任务的出站消息。
enum Outgoing {
    Text(String),
    Ping,
    Close,
}

/// 展示屏上报的“当前展示”（分类/产品）。
#[derive(Clone)]
pub struct Current {
    pub category: String,
    pub product: String,
}

/// 单条客户端连接信息。
#[derive(Clone)]
pub struct ClientInfo {
    pub id: String,
    pub role: String, // "screen" | "admin"
    pub name: String,
    pub ip: String,
    pub ua: String,
    pub connected_at: u64,
    pub last_seen: u64,
    pub alive: bool,
    pub current: Option<Current>,
}

struct Entry {
    info: ClientInfo,
    tx: mpsc::UnboundedSender<Outgoing>,
}

struct LiveInner {
    clients: HashMap<String, Entry>,
}

/// WebSocket 实时通道句柄。
#[derive(Clone)]
pub struct Live {
    inner: Arc<Mutex<LiveInner>>,
}

/// 构造 JSON 消息负载字符串。
fn payload(ty: &str, data: Value) -> String {
    serde_json::to_string(&json!({ "type": ty, "data": data })).unwrap_or_else(|_| "{}".into())
}

/// 取客户端 IP：优先 x-forwarded-for（反向代理）；否则用连接来源 socket。
/// 回环（127.0.0.1 / ::1）回退显示服务器本机局域网 IPv4。
fn peer_ip(headers: &HeaderMap, peer: SocketAddr) -> String {
    let raw = if let Some(xff) = headers.get("x-forwarded-for") {
        xff.to_str()
            .unwrap_or("")
            .split(',')
            .next()
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    } else {
        peer.ip().to_string()
    };
    let mut ip = raw;
    if ip.starts_with("::ffff:") {
        ip = ip[7..].to_string();
    } else if ip == "::1" {
        ip = "127.0.0.1".to_string();
    }
    if ip == "127.0.0.1" {
        return local_lan_ipv4().unwrap_or_else(|| "127.0.0.1".to_string());
    }
    ip
}

impl Live {
    pub fn new() -> Live {
        let live = Live {
            inner: Arc::new(Mutex::new(LiveInner {
                clients: HashMap::new(),
            })),
        };
        let this = live.clone();
        // 心跳：30s 一次 ping，未回 pong 的连接判死并移除
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(30000)).await;
                this.heartbeat_tick().await;
            }
        });
        live
    }

    async fn heartbeat_tick(&self) {
        let mut kills: Vec<String> = Vec::new();
        {
            let mut g = self.inner.lock().await;
            let now = now_ms();
            for (id, e) in g.clients.iter_mut() {
                if e.info.alive {
                    e.info.alive = false;
                    e.info.last_seen = now;
                    let _ = e.tx.send(Outgoing::Ping);
                } else {
                    kills.push(id.clone());
                }
            }
        }
        for id in &kills {
            {
                let g = self.inner.lock().await;
                if let Some(e) = g.clients.get(id) {
                    let _ = e.tx.send(Outgoing::Close);
                }
            }
            self.unregister(id).await;
        }
        // node 每次心跳周期后都会广播一次列表
        self.broadcast_clients().await;
    }

    async fn register(&self, entry: Entry) {
        let mut g = self.inner.lock().await;
        g.clients.insert(entry.info.id.clone(), entry);
    }

    async fn unregister(&self, id: &str) {
        let mut g = self.inner.lock().await;
        g.clients.remove(id);
    }

    /// 客户端列表快照（不含内部句柄）。
    pub async fn list_json(&self) -> Value {
        let g = self.inner.lock().await;
        let now = now_ms();
        let arr: Vec<Value> = g
            .clients
            .values()
            .map(|e| {
                let c = &e.info;
                json!({
                    "id": c.id,
                    "role": c.role,
                    "name": c.name,
                    "ip": c.ip,
                    "ua": c.ua,
                    "connectedAt": c.connected_at,
                    "lastSeen": c.last_seen,
                    "ageSec": now.saturating_sub(c.connected_at) / 1000,
                    "current": c.current.as_ref().map(|cur| json!({
                        "category": cur.category,
                        "product": cur.product
                    })).unwrap_or(Value::Null),
                })
            })
            .collect();
        Value::Array(arr)
    }

    /// 广播命名消息给所有在线客户端（config-changed / control / clients 等）。
    pub async fn broadcast(&self, ty: &str, data: Value) {
        let text = payload(ty, data);
        let mut failed = Vec::new();
        {
            let g = self.inner.lock().await;
            for (id, e) in g.clients.iter() {
                if e.tx.send(Outgoing::Text(text.clone())).is_err() {
                    failed.push(id.clone());
                }
            }
        }
        if !failed.is_empty() {
            let mut g = self.inner.lock().await;
            for id in failed {
                g.clients.remove(&id);
            }
        }
    }

    /// 定向发送给指定客户端 id；不存在/离线返回 false。
    pub async fn send_to(&self, id: &str, ty: &str, data: Value) -> bool {
        let text = payload(ty, data);
        let mut ok = false;
        {
            let g = self.inner.lock().await;
            if let Some(e) = g.clients.get(id) {
                ok = e.tx.send(Outgoing::Text(text)).is_ok();
            }
        }
        ok
    }

    /// 广播最新客户端列表（连接/断开/状态上报/心跳后调用）。
    pub async fn broadcast_clients(&self) {
        let list = self.list_json().await;
        self.broadcast("clients", list).await;
    }
}

/// /api/ws 查询参数。
#[derive(Deserialize)]
pub struct WsParams {
    pub role: Option<String>,
    pub name: Option<String>,
}

/// GET /api/ws —— HTTP upgrade 处理。
pub async fn ws_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<WsParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let role = if q.role.as_deref() == Some("admin") {
        "admin".to_string()
    } else {
        "screen".to_string()
    };
    let name = q.name.unwrap_or_default().trim().to_string();
    let ua = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let ip = peer_ip(&headers, peer);
    let now = now_ms();
    let info = ClientInfo {
        id: Uuid::new_v4().to_string(),
        role,
        name,
        ip,
        ua,
        connected_at: now,
        last_seen: now,
        alive: true,
        current: None,
    };
    let live = state.live.clone();
    ws.on_upgrade(move |socket| async move {
        handle_socket(live, socket, info).await;
    })
}

async fn handle_socket(live: Live, socket: WebSocket, info: ClientInfo) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
    let id = info.id.clone();

    // 注册到在线列表
    live
        .register(Entry {
            info: info.clone(),
            tx: tx.clone(),
        })
        .await;
    // 新连接：先推一次当前列表，再广播让所有客户端（含自己）同步
    let list = live.list_json().await;
    let _ = tx.send(Outgoing::Text(payload("clients", list)));
    live.broadcast_clients().await;

    // 写任务：消费 mpsc 出站消息 → 写 socket（保证单写者）
    let writer = tokio::spawn(async move {
        while let Some(o) = rx.recv().await {
            let is_close = matches!(o, Outgoing::Close);
            let m = match o {
                Outgoing::Text(s) => Message::text(s),
                Outgoing::Ping => Message::Ping(Bytes::new()),
                Outgoing::Close => Message::Close(None),
            };
            if sink.send(m).await.is_err() {
                break;
            }
            if is_close {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // 读任务（本协程）：解析客户端消息 + 响应心跳 pong
    let resp_tx = tx;
    while let Some(item) = stream.next().await {
        match item {
            Ok(Message::Text(t)) => {
                handle_client_message(&live, &id, t.as_str(), &resp_tx).await;
            }
            Ok(Message::Pong(_)) => {
                let mut g = live.inner.lock().await;
                if let Some(e) = g.clients.get_mut(&id) {
                    e.info.alive = true;
                    e.info.last_seen = now_ms();
                }
            }
            Ok(Message::Close(_)) => break,
            _ => {}
        }
    }

    // 断开清理：移出列表并广播
    live.unregister(&id).await;
    live.broadcast_clients().await;
    // 释放最后一个 tx 发送端，让 writer 的 recv() 返回 None 而结束（否则会一直挂起）
    drop(resp_tx);
    let _ = writer.await;
}

/// 处理一条客户端文本消息（get-clients / ping / screen-status / screen-ip）。
async fn handle_client_message(
    live: &Live,
    id: &str,
    text: &str,
    tx: &mpsc::UnboundedSender<Outgoing>,
) {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match ty {
        "get-clients" => {
            let list = live.list_json().await;
            let _ = tx.send(Outgoing::Text(payload("clients", list)));
        }
        "ping" => {
            let _ = tx.send(Outgoing::Text(payload("pong", json!({ "t": now_ms() }))));
        }
        "screen-status" => {
            let is_screen = {
                let g = live.inner.lock().await;
                g.clients
                    .get(id)
                    .map(|e| e.info.role == "screen")
                    .unwrap_or(false)
            };
            if !is_screen {
                return;
            }
            let d = v.get("data").cloned().unwrap_or(Value::Null);
            let to_s = |x: &Value| -> String {
                x.as_str().map(|s| s.to_string()).unwrap_or_default()
            };
            let category = to_s(&d.get("category").cloned().unwrap_or(Value::Null));
            let product = to_s(&d.get("product").cloned().unwrap_or(Value::Null));
            {
                let mut g = live.inner.lock().await;
                if let Some(e) = g.clients.get_mut(id) {
                    e.info.current = Some(Current { category, product });
                }
            }
            live.broadcast_clients().await;
        }
        // 已废弃的 screen-ip 上报：来源地址由 peer_ip 直接取用，忽略。
        _ => {}
    }
}
