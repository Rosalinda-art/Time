import { 
  Task, 
  StudyPlan, 
  StudySession, 
  UserSettings, 
  FixedCommitment,
  TimeSlot,
  ConflictCheckResult,
  RedistributionOptions,
  RedistributionResult,
  SessionSchedulingMetadata,
  SkipMetadata
} from '../types';
import { getLocalDateString, formatTime } from './scheduling';

/**
 * Enhanced Conflict Checker and Validation System
 */
export class ConflictChecker {
  constructor(
    private settings: UserSettings,
    private fixedCommitments: FixedCommitment[]
  ) {}

  /**
   * Validates if a time slot is available and doesn't conflict with existing sessions or commitments
   */
  validateTimeSlot(
    date: string,
    startTime: string,
    endTime: string,
    existingSessions: StudySession[] = [],
    excludeSessionId?: string
  ): ConflictCheckResult {
    const conflicts: ConflictCheckResult['conflicts'] = [];
    
    // Basic time validation
    if (!this.isValidTimeRange(startTime, endTime)) {
      conflicts.push({
        type: 'invalid_time_slot',
        message: 'Invalid time range'
      });
    }

    // Check study window
    if (!this.isWithinStudyWindow(startTime, endTime)) {
      conflicts.push({
        type: 'invalid_time_slot',
        message: `Time slot is outside study window (${this.settings.studyWindowStartHour}:00 - ${this.settings.studyWindowEndHour}:00)`
      });
    }

    // Check work days
    const dayOfWeek = new Date(date).getDay();
    if (!this.settings.workDays.includes(dayOfWeek)) {
      conflicts.push({
        type: 'invalid_time_slot',
        message: 'Date is not a work day'
      });
    }

    // Check session overlaps
    const sessionConflicts = this.checkSessionOverlaps(
      date, startTime, endTime, existingSessions, excludeSessionId
    );
    conflicts.push(...sessionConflicts);

    // Check commitment conflicts
    const commitmentConflicts = this.checkCommitmentConflicts(date, startTime, endTime);
    conflicts.push(...commitmentConflicts);

    // Check daily limits
    const dailyLimitConflicts = this.checkDailyLimits(date, startTime, endTime, existingSessions);
    conflicts.push(...dailyLimitConflicts);

    const isValid = conflicts.length === 0;
    const suggestedAlternatives = isValid ? undefined : this.findAlternativeSlots(
      date, this.calculateDuration(startTime, endTime), existingSessions
    );

    return {
      isValid,
      conflicts,
      suggestedAlternatives
    };
  }

  /**
   * Finds the next available time slot for a given duration
   */
  findNextAvailableSlot(
    requiredHours: number,
    preferredDate: string,
    existingSessions: StudySession[] = [],
    maxDaysToSearch: number = 14
  ): TimeSlot | null {
    const startDate = new Date(preferredDate);
    
    for (let dayOffset = 0; dayOffset < maxDaysToSearch; dayOffset++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(currentDate.getDate() + dayOffset);
      const dateString = currentDate.toISOString().split('T')[0];
      
      // Skip non-work days
      if (!this.settings.workDays.includes(currentDate.getDay())) {
        continue;
      }

      const availableSlots = this.getAvailableTimeSlots(dateString, existingSessions);
      
      for (const slot of availableSlots) {
        if (slot.duration >= requiredHours) {
          return {
            start: slot.start,
            end: this.addHoursToTime(slot.start, requiredHours),
            duration: requiredHours
          };
        }
      }
    }
    
    return null;
  }

  /**
   * Gets all available time slots for a specific date
   */
  private getAvailableTimeSlots(date: string, existingSessions: StudySession[]): TimeSlot[] {
    const slots: TimeSlot[] = [];
    const studyWindowStart = this.settings.studyWindowStartHour * 60; // Convert to minutes
    const studyWindowEnd = this.settings.studyWindowEndHour * 60;
    
    // Get all busy intervals (sessions and commitments)
    const busyIntervals = this.getBusyIntervals(date, existingSessions);
    
    let currentTime = studyWindowStart;
    
    for (const interval of busyIntervals) {
      if (interval.start > currentTime) {
        const duration = (interval.start - currentTime) / 60; // Convert to hours
        if (duration >= (this.settings.minSessionLength || 15) / 60) {
          slots.push({
            start: this.minutesToTimeString(currentTime),
            end: this.minutesToTimeString(interval.start),
            duration
          });
        }
      }
      currentTime = Math.max(currentTime, interval.end);
    }
    
    // Check final slot
    if (currentTime < studyWindowEnd) {
      const duration = (studyWindowEnd - currentTime) / 60;
      if (duration >= (this.settings.minSessionLength || 15) / 60) {
        slots.push({
          start: this.minutesToTimeString(currentTime),
          end: this.minutesToTimeString(studyWindowEnd),
          duration
        });
      }
    }
    
    return slots;
  }

  private getBusyIntervals(date: string, existingSessions: StudySession[]): Array<{ start: number; end: number }> {
    const intervals: Array<{ start: number; end: number }> = [];
    
    // Add existing sessions
    existingSessions.forEach(session => {
      if (session.status !== 'skipped') {
        const startMinutes = this.timeStringToMinutes(session.startTime);
        const endMinutes = this.timeStringToMinutes(session.endTime);
        intervals.push({ start: startMinutes, end: endMinutes });
      }
    });
    
    // Add fixed commitments
    const dayOfWeek = new Date(date).getDay();
    this.fixedCommitments.forEach(commitment => {
      let appliesToDate = false;
      
      if (commitment.recurring && commitment.daysOfWeek.includes(dayOfWeek)) {
        appliesToDate = true;
      } else if (!commitment.recurring && commitment.specificDates?.includes(date)) {
        appliesToDate = true;
      }
      
      if (appliesToDate && !commitment.deletedOccurrences?.includes(date)) {
        const modified = commitment.modifiedOccurrences?.[date];
        const startTime = modified?.startTime || commitment.startTime;
        const endTime = modified?.endTime || commitment.endTime;
        
        intervals.push({
          start: this.timeStringToMinutes(startTime),
          end: this.timeStringToMinutes(endTime)
        });
      }
    });
    
    // Sort and merge overlapping intervals
    intervals.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    
    for (const interval of intervals) {
      if (merged.length === 0 || merged[merged.length - 1].end < interval.start) {
        merged.push(interval);
      } else {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, interval.end);
      }
    }
    
    return merged;
  }

  private checkSessionOverlaps(
    date: string,
    startTime: string,
    endTime: string,
    existingSessions: StudySession[],
    excludeSessionId?: string
  ): ConflictCheckResult['conflicts'] {
    const conflicts: ConflictCheckResult['conflicts'] = [];
    const startMinutes = this.timeStringToMinutes(startTime);
    const endMinutes = this.timeStringToMinutes(endTime);
    
    existingSessions.forEach(session => {
      if (session.status === 'skipped') return;
      
      const sessionId = `${session.taskId}-${session.sessionNumber}`;
      if (excludeSessionId && sessionId === excludeSessionId) return;
      
      const sessionStart = this.timeStringToMinutes(session.startTime);
      const sessionEnd = this.timeStringToMinutes(session.endTime);
      
      if (startMinutes < sessionEnd && endMinutes > sessionStart) {
        conflicts.push({
          type: 'session_overlap',
          message: `Overlaps with existing session (${session.startTime} - ${session.endTime})`,
          conflictingItem: session
        });
      }
    });
    
    return conflicts;
  }

  private checkCommitmentConflicts(
    date: string,
    startTime: string,
    endTime: string
  ): ConflictCheckResult['conflicts'] {
    const conflicts: ConflictCheckResult['conflicts'] = [];
    const startMinutes = this.timeStringToMinutes(startTime);
    const endMinutes = this.timeStringToMinutes(endTime);
    const dayOfWeek = new Date(date).getDay();
    
    this.fixedCommitments.forEach(commitment => {
      let appliesToDate = false;
      
      if (commitment.recurring && commitment.daysOfWeek.includes(dayOfWeek)) {
        appliesToDate = true;
      } else if (!commitment.recurring && commitment.specificDates?.includes(date)) {
        appliesToDate = true;
      }
      
      if (appliesToDate && !commitment.deletedOccurrences?.includes(date)) {
        const modified = commitment.modifiedOccurrences?.[date];
        const commitmentStart = this.timeStringToMinutes(modified?.startTime || commitment.startTime);
        const commitmentEnd = this.timeStringToMinutes(modified?.endTime || commitment.endTime);
        
        if (startMinutes < commitmentEnd && endMinutes > commitmentStart) {
          conflicts.push({
            type: 'commitment_conflict',
            message: `Conflicts with ${commitment.title} (${modified?.startTime || commitment.startTime} - ${modified?.endTime || commitment.endTime})`,
            conflictingItem: commitment
          });
        }
      }
    });
    
    return conflicts;
  }

  private checkDailyLimits(
    date: string,
    startTime: string,
    endTime: string,
    existingSessions: StudySession[]
  ): ConflictCheckResult['conflicts'] {
    const conflicts: ConflictCheckResult['conflicts'] = [];
    const sessionDuration = this.calculateDuration(startTime, endTime);
    
    const existingDailyHours = existingSessions
      .filter(session => session.status !== 'skipped')
      .reduce((sum, session) => sum + session.allocatedHours, 0);
    
    const totalHours = existingDailyHours + sessionDuration;
    
    if (totalHours > this.settings.dailyAvailableHours) {
      conflicts.push({
        type: 'daily_limit_exceeded',
        message: `Would exceed daily limit (${formatTime(totalHours)} > ${formatTime(this.settings.dailyAvailableHours)})`
      });
    }
    
    return conflicts;
  }

  private findAlternativeSlots(
    date: string,
    requiredHours: number,
    existingSessions: StudySession[]
  ): TimeSlot[] {
    const alternatives: TimeSlot[] = [];
    
    // Try same day alternatives
    const availableSlots = this.getAvailableTimeSlots(date, existingSessions);
    availableSlots.forEach(slot => {
      if (slot.duration >= requiredHours) {
        alternatives.push({
          start: slot.start,
          end: this.addHoursToTime(slot.start, requiredHours),
          duration: requiredHours
        });
      }
    });
    
    // If no same-day alternatives, try next few days
    if (alternatives.length === 0) {
      for (let dayOffset = 1; dayOffset <= 3; dayOffset++) {
        const nextDate = new Date(date);
        nextDate.setDate(nextDate.getDate() + dayOffset);
        const nextDateString = nextDate.toISOString().split('T')[0];
        
        if (this.settings.workDays.includes(nextDate.getDay())) {
          const slot = this.findNextAvailableSlot(requiredHours, nextDateString, [], 1);
          if (slot) {
            alternatives.push(slot);
            break;
          }
        }
      }
    }
    
    return alternatives.slice(0, 3); // Return top 3 alternatives
  }

  // Utility methods
  private isValidTimeRange(startTime: string, endTime: string): boolean {
    const start = this.timeStringToMinutes(startTime);
    const end = this.timeStringToMinutes(endTime);
    return start < end && start >= 0 && end <= 24 * 60;
  }

  private isWithinStudyWindow(startTime: string, endTime: string): boolean {
    const start = this.timeStringToMinutes(startTime);
    const end = this.timeStringToMinutes(endTime);
    const windowStart = this.settings.studyWindowStartHour * 60;
    const windowEnd = this.settings.studyWindowEndHour * 60;
    
    return start >= windowStart && end <= windowEnd;
  }

  private calculateDuration(startTime: string, endTime: string): number {
    const start = this.timeStringToMinutes(startTime);
    const end = this.timeStringToMinutes(endTime);
    return (end - start) / 60; // Convert to hours
  }

  private timeStringToMinutes(timeString: string): number {
    const [hours, minutes] = timeString.split(':').map(Number);
    return hours * 60 + (minutes || 0);
  }

  private minutesToTimeString(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
  }

  private addHoursToTime(timeString: string, hours: number): string {
    const startMinutes = this.timeStringToMinutes(timeString);
    const endMinutes = startMinutes + (hours * 60);
    return this.minutesToTimeString(endMinutes);
  }
}

/**
 * Enhanced Priority-Based Redistribution System
 */
export class EnhancedRedistributionEngine {
  private conflictChecker: ConflictChecker;

  constructor(
    private settings: UserSettings,
    private fixedCommitments: FixedCommitment[]
  ) {
    this.conflictChecker = new ConflictChecker(settings, fixedCommitments);
  }

  /**
   * Redistributes missed sessions using smart priority-based algorithm
   */
  redistributeMissedSessions(
    studyPlans: StudyPlan[],
    tasks: Task[],
    options: RedistributionOptions = {
      prioritizeMissedSessions: true,
      respectDailyLimits: true,
      allowWeekendOverflow: false,
      maxRedistributionDays: 14
    }
  ): RedistributionResult {
    const today = getLocalDateString();
    const redistributedSessions: StudySession[] = [];
    const failedSessions: Array<{ session: StudySession; reason: string }> = [];
    let conflictsResolved = 0;
    
    // Step 1: Collect all missed sessions
    const missedSessions = this.collectMissedSessions(studyPlans, tasks, today);
    
    // Step 2: Calculate priorities for each missed session
    const prioritizedSessions = this.calculateSessionPriorities(missedSessions, tasks);
    
    // Step 3: Create working copy of study plans
    const workingPlans = JSON.parse(JSON.stringify(studyPlans)) as StudyPlan[];
    
    // Step 4: Process each missed session in priority order
    for (const missedSession of prioritizedSessions) {
      const result = this.redistributeSession(
        missedSession,
        workingPlans,
        tasks,
        options
      );
      
      if (result.success) {
        redistributedSessions.push(result.newSession);
        conflictsResolved++;
        
        // Update scheduling metadata
        result.newSession.schedulingMetadata = {
          originalSlot: {
            date: missedSession.originalPlanDate,
            startTime: missedSession.session.startTime,
            endTime: missedSession.session.endTime
          },
          rescheduleHistory: [
            {
              from: {
                date: missedSession.originalPlanDate,
                startTime: missedSession.session.startTime,
                endTime: missedSession.session.endTime
              },
              to: {
                date: result.targetDate!,
                startTime: result.newSession.startTime,
                endTime: result.newSession.endTime
              },
              timestamp: new Date().toISOString(),
              reason: 'redistribution'
            }
          ],
          redistributionRound: 1,
          priority: missedSession.priority
        };
        
        // Remove original missed session and add new session
        this.removeSessionFromPlans(workingPlans, missedSession);
        this.addSessionToPlans(workingPlans, result.newSession, result.targetDate!);
        
      } else {
        failedSessions.push({
          session: missedSession.session,
          reason: result.reason
        });
      }
    }
    
    // Step 5: Optimize final schedule
    this.optimizeSchedule(workingPlans);
    
    // Update original plans with results
    studyPlans.length = 0;
    studyPlans.push(...workingPlans);
    
    return {
      redistributedSessions,
      failedSessions,
      conflictsResolved,
      totalSessionsMoved: redistributedSessions.length
    };
  }

  /**
   * Enhanced skip functionality with partial skipping support
   */
  skipSession(
    studyPlans: StudyPlan[],
    planDate: string,
    sessionNumber: number,
    taskId: string,
    options: {
      partialHours?: number;
      reason?: 'user_choice' | 'conflict' | 'overload';
    } = {}
  ): boolean {
    const plan = studyPlans.find(p => p.date === planDate);
    if (!plan) return false;
    
    // Don't allow skipping sessions on locked days
    if (plan.isLocked) return false;
    
    const session = plan.plannedTasks.find(
      s => s.taskId === taskId && s.sessionNumber === sessionNumber
    );
    if (!session) return false;
    
    if (options.partialHours && options.partialHours < session.allocatedHours) {
      // Partial skip: reduce session hours and create a new session for remaining time
      const remainingHours = session.allocatedHours - options.partialHours;
      
      // Update current session
      session.allocatedHours = options.partialHours;
      session.endTime = this.conflictChecker['addHoursToTime'](session.startTime, options.partialHours);
      
      // Create new session for remaining hours
      const remainingSession: StudySession = {
        ...session,
        sessionNumber: (session.sessionNumber || 0) + 1,
        allocatedHours: remainingHours,
        status: 'scheduled',
        schedulingMetadata: {
          originalSlot: {
            date: planDate,
            startTime: session.startTime,
            endTime: session.endTime
          },
          rescheduleHistory: [],
          priority: session.schedulingMetadata?.priority || 0
        }
      };
      
      // Try to find a slot for remaining session
      const slot = this.conflictChecker.findNextAvailableSlot(
        remainingHours,
        planDate,
        plan.plannedTasks
      );
      
      if (slot) {
        remainingSession.startTime = slot.start;
        remainingSession.endTime = slot.end;
        plan.plannedTasks.push(remainingSession);
      }
    } else {
      // Full skip
      session.status = 'skipped';
      session.skipMetadata = {
        skippedAt: new Date().toISOString(),
        reason: options.reason || 'user_choice',
        partialHours: options.partialHours
      };
    }
    
    return true;
  }

  private collectMissedSessions(
    studyPlans: StudyPlan[],
    tasks: Task[],
    today: string
  ): Array<{ session: StudySession; originalPlanDate: string; task: Task; priority: number }> {
    const missedSessions: Array<{ session: StudySession; originalPlanDate: string; task: Task; priority: number }> = [];
    
    studyPlans.forEach(plan => {
      if (plan.date < today) {
        plan.plannedTasks.forEach(session => {
          if (session.status === 'missed' || 
              (!session.done && !session.status?.includes('completed') && plan.date < today)) {
            
            const task = tasks.find(t => t.id === session.taskId);
            if (task && task.status === 'pending') {
              missedSessions.push({
                session,
                originalPlanDate: plan.date,
                task,
                priority: 0 // Will be calculated later
              });
            }
          }
        });
      }
    });
    
    return missedSessions;
  }

  private calculateSessionPriorities(
    missedSessions: Array<{ session: StudySession; originalPlanDate: string; task: Task; priority: number }>,
    tasks: Task[]
  ): Array<{ session: StudySession; originalPlanDate: string; task: Task; priority: number }> {
    const now = new Date();
    
    return missedSessions.map(item => {
      let priority = 0;
      
      // Task importance (0-1000 points)
      if (item.task.importance) {
        priority += 1000;
      }
      
      // Deadline urgency (0-500 points)
      const daysUntilDeadline = (new Date(item.task.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      if (daysUntilDeadline < 0) {
        priority += 500; // Overdue tasks get maximum urgency
      } else if (daysUntilDeadline <= 1) {
        priority += 400;
      } else if (daysUntilDeadline <= 3) {
        priority += 300;
      } else if (daysUntilDeadline <= 7) {
        priority += 200;
      } else {
        priority += Math.max(0, 100 - daysUntilDeadline);
      }
      
      // Session age (0-200 points)
      const daysMissed = (now.getTime() - new Date(item.originalPlanDate).getTime()) / (1000 * 60 * 60 * 24);
      priority += Math.min(200, daysMissed * 10);
      
      // Session duration bonus for longer sessions (0-100 points)
      priority += Math.min(100, item.session.allocatedHours * 20);
      
      return { ...item, priority };
    }).sort((a, b) => b.priority - a.priority);
  }

  private redistributeSession(
    missedSession: { session: StudySession; originalPlanDate: string; task: Task; priority: number },
    workingPlans: StudyPlan[],
    tasks: Task[],
    options: RedistributionOptions
  ): { success: boolean; newSession?: StudySession; targetDate?: string; reason?: string } {
    const { session, task } = missedSession;
    const today = getLocalDateString();
    
    // Calculate deadline with buffer
    const deadline = new Date(task.deadline);
    if (this.settings.bufferDays > 0) {
      deadline.setDate(deadline.getDate() - this.settings.bufferDays);
    }
    const deadlineDateStr = deadline.toISOString().split('T')[0];
    
    // Find best available slot
    for (let dayOffset = 0; dayOffset < options.maxRedistributionDays; dayOffset++) {
      const targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() + dayOffset);
      const targetDateStr = targetDate.toISOString().split('T')[0];
      
      // Check if within deadline
      if (targetDateStr > deadlineDateStr) {
        break;
      }
      
      // Check if it's a work day
      if (!this.settings.workDays.includes(targetDate.getDay())) {
        continue;
      }
      
      // Get existing sessions for this day
      const targetPlan = workingPlans.find(p => p.date === targetDateStr);
      const existingSessions = targetPlan ? targetPlan.plannedTasks : [];
      
      // Skip locked days
      if (targetPlan?.isLocked) {
        continue;
      }
      
      // Find available slot
      const slot = this.conflictChecker.findNextAvailableSlot(
        session.allocatedHours,
        targetDateStr,
        existingSessions,
        1
      );
      
      if (slot) {
        // Validate the slot
        const validation = this.conflictChecker.validateTimeSlot(
          targetDateStr,
          slot.start,
          slot.end,
          existingSessions
        );
        
        if (validation.isValid) {
          const newSession: StudySession = {
            ...session,
            startTime: slot.start,
            endTime: slot.end,
            status: 'rescheduled'
          };
          
          return {
            success: true,
            newSession,
            targetDate: targetDateStr
          };
        }
      }
    }
    
    return {
      success: false,
      reason: 'No available time slots found within deadline'
    };
  }

  private removeSessionFromPlans(
    workingPlans: StudyPlan[],
    missedSession: { session: StudySession; originalPlanDate: string; task: Task; priority: number }
  ): void {
    const plan = workingPlans.find(p => p.date === missedSession.originalPlanDate);
    if (plan) {
      const sessionIndex = plan.plannedTasks.findIndex(
        s => s.taskId === missedSession.session.taskId && 
             s.sessionNumber === missedSession.session.sessionNumber
      );
      if (sessionIndex !== -1) {
        plan.plannedTasks.splice(sessionIndex, 1);
      }
    }
  }

  private addSessionToPlans(
    workingPlans: StudyPlan[],
    newSession: StudySession,
    targetDate: string
  ): void {
    let targetPlan = workingPlans.find(p => p.date === targetDate);
    
    if (!targetPlan) {
      targetPlan = {
        id: `plan-${targetDate}`,
        date: targetDate,
        plannedTasks: [],
        totalStudyHours: 0,
        availableHours: this.settings.dailyAvailableHours
      };
      workingPlans.push(targetPlan);
    }
    
    targetPlan.plannedTasks.push(newSession);
    targetPlan.totalStudyHours += newSession.allocatedHours;
  }

  private optimizeSchedule(workingPlans: StudyPlan[]): void {
    // Sort sessions by start time within each plan
    workingPlans.forEach(plan => {
      plan.plannedTasks.sort((a, b) => {
        if (a.startTime && b.startTime) {
          return a.startTime.localeCompare(b.startTime);
        }
        return 0;
      });
    });
    
    // Sort plans by date
    workingPlans.sort((a, b) => a.date.localeCompare(b.date));
  }
}

/**
 * Factory function to create enhanced redistribution engine
 */
export function createEnhancedRedistributionEngine(
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
): EnhancedRedistributionEngine {
  return new EnhancedRedistributionEngine(settings, fixedCommitments);
}

/**
 * Factory function to create conflict checker
 */
export function createConflictChecker(
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
): ConflictChecker {
  return new ConflictChecker(settings, fixedCommitments);
}
