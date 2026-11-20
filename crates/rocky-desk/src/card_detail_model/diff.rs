//! Paged unified diff of one change card block.

use rocky_proto::pipe::{ClientMsg, DiffLine};

use super::handle_ack;

/// Load state of an opened paged block diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffState {
    Loading,
    Page {
        lines: Vec<DiffLine>,
        page: u32,
        pages: u32,
    },
    Missing,
    NotFound,
}

/// Pure request/reply state machine for one block's paged unified diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffModel {
    card_id: String,
    seq: u32,
    page: u32,
    known_pages: Option<u32>,
    pending_id: Option<u64>,
    reopened: bool,
    state: DiffState,
}

impl DiffModel {
    /// Opens the diff at page `0` and returns the model with the outgoing `BlockDiff` request.
    pub fn open(card_id: String, seq: u32, id: u64) -> (DiffModel, ClientMsg) {
        let msg = ClientMsg::BlockDiff {
            id,
            card_id: card_id.clone(),
            seq,
            page: 0,
        };
        let model = Self {
            card_id,
            seq,
            page: 0,
            known_pages: None,
            pending_id: Some(id),
            reopened: false,
            state: DiffState::Loading,
        };
        (model, msg)
    }

    /// Resets to `Loading`, re-requests `seq` and `page` after reconnect, and marks `NotFound` to close views.
    pub fn reopen(&mut self, id: u64) -> ClientMsg {
        self.pending_id = Some(id);
        self.reopened = true;
        self.state = DiffState::Loading;
        ClientMsg::BlockDiff {
            id,
            card_id: self.card_id.clone(),
            seq: self.seq,
            page: self.page,
        }
    }

    /// Pending request id awaiting a `BlockDiff` or `Ack` reply.
    pub fn pending_id(&self) -> Option<u64> {
        self.pending_id
    }

    /// True if a reconnect re-open ended with `DiffState::NotFound`.
    pub fn reopened_not_found(&self) -> bool {
        self.reopened && self.state == DiffState::NotFound
    }

    /// Requests another `page` when total pages are known and `page < pages`.
    pub fn go(&mut self, page: u32, id: u64) -> Option<ClientMsg> {
        let pages = self.known_pages?;
        if page >= pages {
            return None;
        }
        self.page = page;
        self.pending_id = Some(id);
        self.reopened = false;
        self.state = DiffState::Loading;
        Some(ClientMsg::BlockDiff {
            id,
            card_id: self.card_id.clone(),
            seq: self.seq,
            page,
        })
    }

    /// Applies a `ServerMsg::BlockDiff` reply if `id` matches the active pending request.
    pub fn on_diff(&mut self, id: u64, lines: Vec<DiffLine>, page: u32, pages: u32, missing: bool) {
        if self.pending_id != Some(id) {
            return;
        }
        self.pending_id = None;
        self.reopened = false;
        if missing {
            self.known_pages = None;
            self.state = DiffState::Missing;
            return;
        }
        self.page = page;
        self.known_pages = Some(pages);
        self.state = DiffState::Page { lines, page, pages };
    }

    /// Applies an `Ack` reply for the pending diff request; failures transition to `NotFound`.
    pub fn on_ack(&mut self, id: u64, ok: bool) {
        if handle_ack(&mut self.pending_id, id, ok) {
            self.known_pages = None;
            self.state = DiffState::NotFound;
        }
    }

    /// Current diff load state.
    pub fn state(&self) -> &DiffState {
        &self.state
    }

    /// Identifier of the card targeted by this diff model.
    pub fn card_id(&self) -> &str {
        &self.card_id
    }

    /// Block sequence number targeted by this diff model.
    pub fn seq(&self) -> u32 {
        self.seq
    }

    /// Zero-based page index currently requested or displayed by this diff model.
    pub fn page(&self) -> u32 {
        self.page
    }
}
