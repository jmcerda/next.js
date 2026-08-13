//! Garbage collection for the persistent backend.
//!
//! GC identifies and tears down tasks that have no reverse references using the `parent_count` and
//! `transient_ref_count`. Tasks are marked `deleted` and then have their outgoing edges teared down
//! recursively.
//!
//! A collected task also has its cell data released immediately to deliver immediate memory wins.
//!
//! The pass runs under the coordinator's GC phase (see
//! [`SnapshotCoordinator::begin_gc`](crate::backend::snapshot_coordinator)), which excludes normal
//! operations. That exclusion is what lets a pass edit the graph without racing a mutation that
//! could resurrect a task mid-collect, and hand its decisions straight to persistence.
//!
//! TODO: find a way to collect GC roots that go away between sessions.  Right now they are
//! persisted forever and if a later session doesn't read them it is never deleted.

use std::{fmt::Display, ops::ControlFlow, sync::atomic::Ordering};

use turbo_tasks::{TaskId, TurboTasks, scope_unbounded::scope_unbounded_with};

use crate::backend::{
    TurboTasksBackend,
    operation::{
        AggregationUpdateQueue, CleanupOldEdgesOperation, ExecuteContext, ExecuteContextImpl,
        TaskGuard, capture_all_outgoing_edges,
    },
    storage::{SpecificTaskDataCategory, TaskDataCategory},
    storage_schema::TaskStorageAccessors,
};

/// One unit of GC work.
enum GcJob {
    /// Scan one shard of the resident map (by index) and enqueue its candidates as
    /// [`GcJob::Collect`].
    ScanShard(usize),
    /// Collect a single task
    Collect(TaskId),
}

/// Observability counters for one [`TurboTasksBackend::gc_collect`] pass.
#[derive(Default)]
pub(crate) struct GcStats {
    /// Tasks collected (marked soft-deleted).
    pub collected: usize,
    /// Edges torn down across all collected tasks (children + forward-dependency reverse edges).
    pub edges_deleted: usize,
}

impl Display for GcStats {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "collected: {collected}, edges_deleted: {edges_deleted}",
            collected = self.collected,
            edges_deleted = self.edges_deleted
        )
    }
}

impl GcStats {
    fn merge(mut self, other: Self) -> Self {
        self.collected += other.collected;
        self.edges_deleted += other.edges_deleted;
        self
    }
}

impl TurboTasksBackend {
    /// Collect all garbage from the task-cache
    ///
    /// Returns [`GcStats`] for the pass.
    pub(crate) fn gc_collect(&self, turbo_tasks: &TurboTasks<TurboTasksBackend>) -> GcStats {
        // TODO(perf): recycle the task ids of collected tasks.
        scope_unbounded_with(
            (0..self.storage.shard_count()).map(GcJob::ScanShard),
            GcStats::default,
            |spawner, job, stats| {
                let collector = |task_id| spawner.spawn(GcJob::Collect(task_id));
                let task_id = match job {
                    GcJob::ScanShard(index) => {
                        self.storage.gc_scan_shard(index, collector);
                        return ControlFlow::Continue(());
                    }
                    GcJob::Collect(task_id) => task_id,
                };
                let mut ctx = ExecuteContextImpl::new_for_gc(self, turbo_tasks, &collector);
                // `All` restores Data so the edge capture below can read the Data-category dep
                // sets.
                let mut task = ctx.task(task_id, TaskDataCategory::All);
                // Recheck under the guard: a racing teardown can add uppers/followers that
                // temporarily remove collectibility. Such a task is re-enqueued by a later pass.
                if !task.is_gc_collectible() {
                    return ControlFlow::Continue(());
                }

                let old_edges = capture_all_outgoing_edges(&task);
                // Clear `immutable` defensively so `resurrect_deleted` can mark the task dirty if
                // it needs to
                task.set_immutable(false);
                // Drop the whole cell payload. This recovers most of the RAM while persistence
                // writes the tombstone.
                let _ = task.take_cell_data();
                task.set_deleted(true);
                if task.new_task() {
                    task.discard_modifications_for_gc_new_task();
                } else {
                    // Persisted ensure it is marked modified so the next snapshot tombstones it.
                    // It is almost certainly already marked modified, so this is mostly a no-op.
                    let _ = task.track_modification(SpecificTaskDataCategory::Meta, "gc_deleted");
                }
                drop(task); // drop the lock so CleanupOldEdgesOperation can run
                stats.collected += 1;
                stats.edges_deleted += old_edges.len();
                CleanupOldEdgesOperation::run(
                    task_id,
                    old_edges,
                    AggregationUpdateQueue::new(),
                    &mut ctx,
                );
                ControlFlow::Continue(())
            },
            GcStats::merge,
        )
    }

    pub(super) fn gc_pin(&self, task: TaskId, turbo_tasks: &TurboTasks<TurboTasksBackend>) {
        self.gc_update_pin(task, 1, "pin_task_for_gc", turbo_tasks);
    }

    pub(super) fn gc_unpin(&self, task: TaskId, turbo_tasks: &TurboTasks<TurboTasksBackend>) {
        self.gc_update_pin(task, -1, "unpin_task_for_gc", turbo_tasks);
    }

    /// Applies `delta` to a task's `transient_ref_count`
    fn gc_update_pin(
        &self,
        task: TaskId,
        delta: i32,
        op: &'static str,
        turbo_tasks: &TurboTasks<TurboTasksBackend>,
    ) {
        // Once stopping, GC bookkeeping is irrelevant. This also keeps handles finalized during
        // shutdown (after the map is dropped) from underflowing the count.
        if self.stopping.load(Ordering::Acquire) {
            return;
        }
        let mut ctx = self.execute_context(turbo_tasks);
        // Technically we only need to manipulate transient data so meta is overkill. But the task
        // must be resident if we are adding a pin so this isn't wasteful
        let mut task = ctx.task(task, TaskDataCategory::Meta);
        task.assert_not_deleted(op);
        task.update_and_get_transient_ref_count(delta);
    }

    /// Runs a full GC pass under the GC phase and returns the number of tasks collected.
    #[doc(hidden)]
    pub fn gc_for_testing(&self, turbo_tasks: &TurboTasks<TurboTasksBackend>) -> usize {
        let _serialize = self.snapshot_in_progress.lock();
        let _gc_phase = self.snapshot_coord.begin_gc();
        self.gc_collect(turbo_tasks).collected
    }
}
