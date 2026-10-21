"""In-memory connection state shared by the companion and native HA host."""
from dataclasses import dataclass, field
import threading

@dataclass(repr=False)
class Session:
    expires_at: float
    profile: object = None
    model: str = ""
    api_key: str = ""
    endpoint: str = ""
    generation: int = 0
    pending: object = None
    pending_request_id: str = ""
    cancelled_request_ids: set = field(default_factory=set)
    lock: object = field(default_factory=threading.RLock)

    def clear(self):
        with self.lock:
            self.generation += 1
            self.cancelled_request_ids.clear()
            if self.pending:
                self.pending.cancel()
            self.profile = None
            self.model = self.api_key = self.endpoint = ""

    def public(self):
        with self.lock:
            result = {"connected": self.profile is not None, "expires_at": int(self.expires_at)}
            if self.profile:
                result.update(provider=self.profile.id, model=self.model, endpoint=self.endpoint, local=self.profile.local)
            return result

