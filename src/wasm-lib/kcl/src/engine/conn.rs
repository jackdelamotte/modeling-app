//! Functions for setting up our WebSocket and WebRTC connections for communications with the
//! engine.

use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use dashmap::DashMap;
use futures::{SinkExt, StreamExt};
use kittycad::types::{OkWebSocketResponseData, WebSocketRequest, WebSocketResponse};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message as WsMsg;

use crate::{
    engine::EngineManager,
    errors::{KclError, KclErrorDetails},
};

#[derive(Debug, PartialEq)]
enum SocketHealth {
    Active,
    Inactive,
}

type WebSocketTcpWrite = futures::stream::SplitSink<tokio_tungstenite::WebSocketStream<reqwest::Upgraded>, WsMsg>;
#[derive(Debug, Clone)]
#[allow(dead_code)] // for the TcpReadHandle
pub struct EngineConnection {
    engine_req_tx: mpsc::Sender<ToEngineReq>,
    responses: Arc<DashMap<uuid::Uuid, WebSocketResponse>>,
    tcp_read_handle: Arc<TcpReadHandle>,
    socket_health: Arc<Mutex<SocketHealth>>,
    batch: Arc<Mutex<Vec<WebSocketRequest>>>,
}

pub struct TcpRead {
    stream: futures::stream::SplitStream<tokio_tungstenite::WebSocketStream<reqwest::Upgraded>>,
}

impl TcpRead {
    pub async fn read(&mut self) -> Result<WebSocketResponse> {
        let Some(msg) = self.stream.next().await else {
            anyhow::bail!("Failed to read from websocket");
        };
        let msg: WebSocketResponse = match msg? {
            WsMsg::Text(text) => serde_json::from_str(&text)?,
            WsMsg::Binary(bin) => bson::from_slice(&bin)?,
            other => anyhow::bail!("Unexpected websocket message from server: {}", other),
        };
        Ok(msg)
    }
}

#[derive(Debug)]
pub struct TcpReadHandle {
    handle: Arc<tokio::task::JoinHandle<Result<()>>>,
}

impl Drop for TcpReadHandle {
    fn drop(&mut self) {
        // Drop the read handle.
        self.handle.abort();
    }
}

/// Requests to send to the engine, and a way to await a response.
struct ToEngineReq {
    /// The request to send
    req: WebSocketRequest,
    /// If this resolves to Ok, the request was sent.
    /// If this resolves to Err, the request could not be sent.
    /// If this has not yet resolved, the request has not been sent yet.
    request_sent: oneshot::Sender<Result<()>>,
}

impl EngineConnection {
    /// Start waiting for incoming engine requests, and send each one over the WebSocket to the engine.
    async fn start_write_actor(mut tcp_write: WebSocketTcpWrite, mut engine_req_rx: mpsc::Receiver<ToEngineReq>) {
        while let Some(req) = engine_req_rx.recv().await {
            let ToEngineReq { req, request_sent } = req;
            let res = if let kittycad::types::WebSocketRequest::ModelingCmdReq {
                cmd: kittycad::types::ModelingCmd::ImportFiles { .. },
                cmd_id: _,
            } = &req
            {
                // Send it as binary.
                Self::inner_send_to_engine_binary(req, &mut tcp_write).await
            } else {
                Self::inner_send_to_engine(req, &mut tcp_write).await
            };
            let _ = request_sent.send(res);
        }
    }

    /// Send the given `request` to the engine via the WebSocket connection `tcp_write`.
    async fn inner_send_to_engine(request: WebSocketRequest, tcp_write: &mut WebSocketTcpWrite) -> Result<()> {
        let msg = serde_json::to_string(&request).map_err(|e| anyhow!("could not serialize json: {e}"))?;
        tcp_write
            .send(WsMsg::Text(msg))
            .await
            .map_err(|e| anyhow!("could not send json over websocket: {e}"))?;
        Ok(())
    }

    /// Send the given `request` to the engine via the WebSocket connection `tcp_write` as binary.
    async fn inner_send_to_engine_binary(request: WebSocketRequest, tcp_write: &mut WebSocketTcpWrite) -> Result<()> {
        let msg = bson::to_vec(&request).map_err(|e| anyhow!("could not serialize bson: {e}"))?;
        tcp_write
            .send(WsMsg::Binary(msg))
            .await
            .map_err(|e| anyhow!("could not send json over websocket: {e}"))?;
        Ok(())
    }

    pub async fn new(ws: reqwest::Upgraded) -> Result<EngineConnection> {
        let ws_stream = tokio_tungstenite::WebSocketStream::from_raw_socket(
            ws,
            tokio_tungstenite::tungstenite::protocol::Role::Client,
            Some(tokio_tungstenite::tungstenite::protocol::WebSocketConfig { ..Default::default() }),
        )
        .await;

        let (tcp_write, tcp_read) = ws_stream.split();
        let (engine_req_tx, engine_req_rx) = mpsc::channel(10);
        tokio::task::spawn(Self::start_write_actor(tcp_write, engine_req_rx));

        let mut tcp_read = TcpRead { stream: tcp_read };

        let responses: Arc<DashMap<uuid::Uuid, WebSocketResponse>> = Arc::new(DashMap::new());
        let responses_clone = responses.clone();
        let socket_health = Arc::new(Mutex::new(SocketHealth::Active));

        let socket_health_tcp_read = socket_health.clone();
        let tcp_read_handle = tokio::spawn(async move {
            // Get Websocket messages from API server
            loop {
                match tcp_read.read().await {
                    Ok(ws_resp) => {
                        if let Some(id) = ws_resp.request_id {
                            responses_clone.insert(id, ws_resp.clone());
                        }
                    }
                    Err(e) => {
                        println!("got ws error: {:?}", e);
                        *socket_health_tcp_read.lock().unwrap() = SocketHealth::Inactive;
                        return Err(e);
                    }
                }
            }
        });

        Ok(EngineConnection {
            engine_req_tx,
            tcp_read_handle: Arc::new(TcpReadHandle {
                handle: Arc::new(tcp_read_handle),
            }),
            responses,
            socket_health,
            batch: Arc::new(Mutex::new(Vec::new())),
        })
    }
}


fn is_cmd_with_return_values(cmd: &kittycad::types::ModelingCmd) -> bool {
    let (kittycad::types::ModelingCmd::Export { .. }
    | kittycad::types::ModelingCmd::Extrude { .. }
    | kittycad::types::ModelingCmd::SketchModeDisable { .. }
    | kittycad::types::ModelingCmd::ObjectBringToFront { .. }
    | kittycad::types::ModelingCmd::SelectWithPoint { .. }
    | kittycad::types::ModelingCmd::HighlightSetEntity { .. }
    | kittycad::types::ModelingCmd::EntityGetChildUuid { .. }
    | kittycad::types::ModelingCmd::EntityGetNumChildren { .. }
    | kittycad::types::ModelingCmd::EntityGetParentId { .. }
    | kittycad::types::ModelingCmd::EntityGetAllChildUuids { .. }
    | kittycad::types::ModelingCmd::CameraDragMove { .. }
    | kittycad::types::ModelingCmd::CameraDragEnd { .. }
    | kittycad::types::ModelingCmd::DefaultCameraGetSettings { .. }
    | kittycad::types::ModelingCmd::DefaultCameraZoom { .. }
    | kittycad::types::ModelingCmd::SelectGet { .. }
    | kittycad::types::ModelingCmd::Solid3DGetAllEdgeFaces { .. }
    | kittycad::types::ModelingCmd::Solid3DGetAllOppositeEdges { .. }
    | kittycad::types::ModelingCmd::Solid3DGetOppositeEdge { .. }
    | kittycad::types::ModelingCmd::Solid3DGetNextAdjacentEdge { .. }
    | kittycad::types::ModelingCmd::Solid3DGetPrevAdjacentEdge { .. }
    | kittycad::types::ModelingCmd::GetEntityType { .. }
    | kittycad::types::ModelingCmd::CurveGetControlPoints { .. }
    | kittycad::types::ModelingCmd::CurveGetType { .. }
    | kittycad::types::ModelingCmd::MouseClick { .. }
    | kittycad::types::ModelingCmd::TakeSnapshot { .. }
    | kittycad::types::ModelingCmd::PathGetInfo { .. }
    | kittycad::types::ModelingCmd::PathGetCurveUuidsForVertices { .. }
    | kittycad::types::ModelingCmd::PathGetVertexUuids { .. }
    | kittycad::types::ModelingCmd::CurveGetEndPoints { .. }
    | kittycad::types::ModelingCmd::FaceIsPlanar { .. }
    | kittycad::types::ModelingCmd::FaceGetPosition { .. }
    | kittycad::types::ModelingCmd::FaceGetGradient { .. }
    | kittycad::types::ModelingCmd::PlaneIntersectAndProject { .. }
    | kittycad::types::ModelingCmd::ImportFiles { .. }
    | kittycad::types::ModelingCmd::Mass { .. }
    | kittycad::types::ModelingCmd::Volume { .. }
    | kittycad::types::ModelingCmd::Density { .. }
    | kittycad::types::ModelingCmd::SurfaceArea { .. }
    | kittycad::types::ModelingCmd::CenterOfMass { .. }
    | kittycad::types::ModelingCmd::GetSketchModePlane { .. }
    | kittycad::types::ModelingCmd::EntityGetDistance { .. }
    | kittycad::types::ModelingCmd::EntityLinearPattern { .. }
    | kittycad::types::ModelingCmd::EntityCircularPattern { .. }
    | kittycad::types::ModelingCmd::Solid3DGetExtrusionFaceInfo { .. }) = cmd
    else {
        return false;
    };

    true
}


#[async_trait::async_trait]
impl EngineManager for EngineConnection {
    async fn send_modeling_cmd(
        &self,
        flush_batch: bool,
        id: uuid::Uuid,
        source_range: crate::executor::SourceRange,
        cmd: kittycad::types::ModelingCmd,
    ) -> Result<OkWebSocketResponseData, KclError> {
        let req = WebSocketRequest::ModelingCmdReq {
          cmd: cmd.clone(),
          cmd_id: id,
        };

        println!("req {:?}", req);

        if !flush_batch {
          self.batch.lock().unwrap().push(req);
        }

        // If the batch only has this one command that expects a return value,
        // fire it right away, or if we want to flush batch queue.
        let is_sending = (is_cmd_with_return_values(&cmd) && self.batch.lock().unwrap().len() == 1)
          || flush_batch
          || is_cmd_with_return_values(&cmd);

        // Return a fake modeling_request empty response.
        if !is_sending {
          println!("fake {:?}", cmd);
          return Ok(OkWebSocketResponseData::Modeling {
            modeling_response: kittycad::types::OkModelingCmdResponse::Empty {}
          });
        }

        let batched_requests =
          WebSocketRequest::ModelingCmdBatchReq {
           requests: self.batch.lock().unwrap().iter().fold(vec![], |mut acc, val| {
              let WebSocketRequest::ModelingCmdReq { cmd, cmd_id } = val else { return acc; };
              acc.push(kittycad::types::ModelingCmdReq {
                cmd: cmd.clone(),
                cmd_id: *cmd_id,
              });
              acc
           }),
           batch_id: id
          };

        let final_req = if self.batch.lock().unwrap().len() == 1 {
          self.batch.lock().unwrap().get(0).unwrap().clone()
        } else {
          batched_requests
        };

        // Throw away the old batch queue.
        self.batch.lock().unwrap().clear();

        println!("final req {:?}", final_req);

        let (tx, rx) = oneshot::channel();

        // Send the request to the engine, via the actor.
        self.engine_req_tx
            .send(ToEngineReq {
                req: final_req.clone(),
                request_sent: tx,
            })
            .await
            .map_err(|e| {
                KclError::Engine(KclErrorDetails {
                    message: format!("Failed to send modeling command: {}", e),
                    source_ranges: vec![source_range],
                })
            })?;

        // Wait for the request to be sent.
        rx.await
            .map_err(|e| {
                KclError::Engine(KclErrorDetails {
                    message: format!("could not send request to the engine actor: {e}"),
                    source_ranges: vec![source_range],
                })
            })?
            .map_err(|e| {
                KclError::Engine(KclErrorDetails {
                    message: format!("could not send request to the engine: {e}"),
                    source_ranges: vec![source_range],
                })
            })?;


        // Wait for the response.
        let current_time = std::time::Instant::now();
        while current_time.elapsed().as_secs() < 60 {
            if let Ok(guard) = self.socket_health.lock() {
                if *guard == SocketHealth::Inactive {
                    return Err(KclError::Engine(KclErrorDetails {
                        message: "Modeling command failed: websocket closed early".to_string(),
                        source_ranges: vec![source_range],
                    }));
                }
            }
            // We pop off the responses to cleanup our mappings.
            if let Some((_, resp)) = self.responses.remove(&id) {
                println!("{:?}", resp);
                return if let Some(data) = &resp.resp {
                    Ok(data.clone())
                } else {
                    Err(KclError::Engine(KclErrorDetails {
                        message: format!("Modeling command failed: {:?}", resp.errors),
                        source_ranges: vec![source_range],
                    }))
                };
            }
        }

        Err(KclError::Engine(KclErrorDetails {
            message: format!("Modeling command timed out `{}`", id),
            source_ranges: vec![source_range],
        }))
    }
}
