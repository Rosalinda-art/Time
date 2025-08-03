import { Task, StudyPlan, StudySession, UserSettings, FixedCommitment, TimeSlot } from '../types';
import moment from 'moment';

export function getLocalDateString(date?: Date): string {
  const d = date || new Date();
  return d.toISOString().split('T')[0];
}

export function formatTime(hours: number): string {
  if (hours === 0) return '0h';
  
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatTimeForTimer(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function checkSessionStatus(session: StudySession, planDate: string): 'scheduled' | 'overdue' | 'missed' | 'completed' {
  if (session.done || session.status === 'completed') {
    return 'completed';
  }
  
  if (session.status === 'missed') {
    return 'missed';
  }
  
  const today = getLocalDateString();
  const sessionDate = planDate;
  
  if (sessionDate < today) {
    const now = new Date();
    const sessionDateTime = new Date(`${sessionDate}T${session.endTime}:00`);
    
    if (sessionDateTime < now) {
      return 'missed';
    }
  }
  
  if (sessionDate === today) {
    const now = new Date();
    const sessionEndTime = new Date(`${sessionDate}T${session.endTime}:00`);
    
    if (sessionEndTime < now && !session.done && session.status !== 'completed') {
      return 'overdue';
    }
  }
  
  return 'scheduled';
}

export function findNextAvailableTimeSlot(
  requiredHours: number,
  startDate: string,
  studyPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  maxDaysToSearch: number = 30
): { date: string; startTime: string; endTime: string } | null {
  const start = new Date(startDate);
  
  for (let dayOffset = 0; dayOffset < maxDaysToSearch; dayOffset++) {
    const currentDate = new Date(start);
    currentDate.setDate(currentDate.getDate() + dayOffset);
    const dateString = currentDate.toISOString().split('T')[0];
    
    // Skip non-work days
    const dayOfWeek = currentDate.getDay();
    if (!settings.workDays.includes(dayOfWeek)) {
      continue;
    }
    
    // Check if this day is locked
    const dayPlan = studyPlans.find(plan => plan.date === dateString);
    if (dayPlan?.isLocked) {
      continue; // Skip locked days entirely
    }
    
    const availableSlots = getDailyAvailableTimeSlots(dateString, studyPlans, settings, fixedCommitments);
    
    for (const slot of availableSlots) {
      if (slot.duration >= requiredHours) {
        const endTime = addHoursToTime(slot.start, requiredHours);
        return {
          date: dateString,
          startTime: slot.start,
          endTime: endTime
        };
      }
    }
  }
  
  return null;
}

export function getDailyAvailableTimeSlots(
  date: string,
  studyPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
): TimeSlot[] {
  const dayPlan = studyPlans.find(plan => plan.date === date);
  
  // If day is locked, return empty slots (no availability)
  if (dayPlan?.isLocked) {
    return [];
  }
  
  const existingSessions = dayPlan ? dayPlan.plannedTasks.filter(session => session.status !== 'skipped') : [];
  const busyIntervals: Array<{ start: number; end: number }> = [];
  
  // Add existing study sessions
  existingSessions.forEach(session => {
    const startMinutes = timeStringToMinutes(session.startTime);
    const endMinutes = timeStringToMinutes(session.endTime);
    busyIntervals.push({ start: startMinutes, end: endMinutes });
  });
  
  // Add fixed commitments
  const dayOfWeek = new Date(date).getDay();
  fixedCommitments.forEach(commitment => {
    let shouldInclude = false;
    
    if (commitment.recurring && commitment.daysOfWeek.includes(dayOfWeek)) {
      shouldInclude = true;
    } else if (!commitment.recurring && commitment.specificDates?.includes(date)) {
      shouldInclude = true;
    }
    
    if (shouldInclude && !commitment.deletedOccurrences?.includes(date)) {
      const modifiedSession = commitment.modifiedOccurrences?.[date];
      const startTime = modifiedSession?.startTime || commitment.startTime;
      const endTime = modifiedSession?.endTime || commitment.endTime;
      
      busyIntervals.push({
        start: timeStringToMinutes(startTime),
        end: timeStringToMinutes(endTime)
      });
    }
  });
  
  // Sort and merge overlapping intervals
  busyIntervals.sort((a, b) => a.start - b.start);
  const mergedIntervals: Array<{ start: number; end: number }> = [];
  
  for (const interval of busyIntervals) {
    if (mergedIntervals.length === 0 || mergedIntervals[mergedIntervals.length - 1].end < interval.start) {
      mergedIntervals.push(interval);
    } else {
      mergedIntervals[mergedIntervals.length - 1].end = Math.max(mergedIntervals[mergedIntervals.length - 1].end, interval.end);
    }
  }
  
  // Find available slots
  const availableSlots: TimeSlot[] = [];
  const studyWindowStart = settings.studyWindowStartHour * 60;
  const studyWindowEnd = settings.studyWindowEndHour * 60;
  
  let currentTime = studyWindowStart;
  
  for (const interval of mergedIntervals) {
    if (interval.start > currentTime) {
      const duration = (interval.start - currentTime) / 60;
      if (duration >= (settings.minSessionLength || 15) / 60) {
        availableSlots.push({
          start: minutesToTimeString(currentTime),
          end: minutesToTimeString(interval.start),
          duration
        });
      }
    }
    currentTime = Math.max(currentTime, interval.end);
  }
  
  // Check final slot
  if (currentTime < studyWindowEnd) {
    const duration = (studyWindowEnd - currentTime) / 60;
    if (duration >= (settings.minSessionLength || 15) / 60) {
      availableSlots.push({
        start: minutesToTimeString(currentTime),
        end: minutesToTimeString(studyWindowEnd),
        duration
      });
    }
  }
  
  return availableSlots;
}

function timeStringToMinutes(timeString: string): number {
  const [hours, minutes] = timeString.split(':').map(Number);
  return hours * 60 + (minutes || 0);
}

function minutesToTimeString(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

function addHoursToTime(timeString: string, hours: number): string {
  const startMinutes = timeStringToMinutes(timeString);
  const endMinutes = startMinutes + (hours * 60);
  return minutesToTimeString(endMinutes);
}

/**
 * Calculate remaining hours for a task, excluding locked sessions
 */
export function calculateRemainingTaskHours(
  task: Task,
  studyPlans: StudyPlan[]
): number {
  // Get all sessions for this task
  const taskSessions = studyPlans.flatMap(plan => 
    plan.plannedTasks.filter(session => session.taskId === task.id)
  );
  
  // Calculate hours from completed sessions and locked sessions
  const allocatedHours = taskSessions
    .filter(session => 
      session.done || 
      session.status === 'completed' || 
      session.status === 'skipped' ||
      isSessionLocked(session, studyPlans)
    )
    .reduce((sum, session) => sum + session.allocatedHours, 0);
  
  return Math.max(0, task.estimatedHours - allocatedHours);
}

/**
 * Check if a session is on a locked day
 */
export function isSessionLocked(session: StudySession, studyPlans: StudyPlan[]): boolean {
  // Find the plan that contains this session
  const plan = studyPlans.find(plan => 
    plan.plannedTasks.some(s => 
      s.taskId === session.taskId && s.sessionNumber === session.sessionNumber
    )
  );
  
  return plan?.isLocked || false;
}

/**
 * Get unlocked sessions for a task that can be redistributed
 */
export function getUnlockedTaskSessions(
  taskId: string,
  studyPlans: StudyPlan[]
): Array<{ session: StudySession; planDate: string }> {
  const unlockedSessions: Array<{ session: StudySession; planDate: string }> = [];
  
  studyPlans.forEach(plan => {
    // Skip locked days entirely
    if (plan.isLocked) return;
    
    plan.plannedTasks.forEach(session => {
      if (session.taskId === taskId && 
          !session.done && 
          session.status !== 'completed' && 
          session.status !== 'skipped') {
        unlockedSessions.push({ session, planDate: plan.date });
      }
    });
  });
  
  return unlockedSessions;
}

/**
 * Remove unlocked sessions for a task from study plans
 */
export function removeUnlockedTaskSessions(
  taskId: string,
  studyPlans: StudyPlan[]
): void {
  studyPlans.forEach(plan => {
    // Skip locked days - don't remove sessions from locked days
    if (plan.isLocked) return;
    
    plan.plannedTasks = plan.plannedTasks.filter(session => 
      session.taskId !== taskId || 
      session.done || 
      session.status === 'completed' || 
      session.status === 'skipped'
    );
    
    // Recalculate total study hours for the day
    plan.totalStudyHours = plan.plannedTasks
      .filter(session => session.status !== 'skipped')
      .reduce((sum, session) => sum + session.allocatedHours, 0);
  });
}

/**
 * Enhanced study plan generation that respects locked days
 */
export function generateNewStudyPlan(
  tasks: Task[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  existingPlans: StudyPlan[] = []
): StudyPlan[] {
  console.log('🚀 Starting enhanced study plan generation...');
  
  // Create a working copy of existing plans to preserve locked days
  const workingPlans: StudyPlan[] = JSON.parse(JSON.stringify(existingPlans));
  
  // Get pending tasks and calculate remaining hours for each
  const pendingTasks = tasks.filter(task => task.status === 'pending');
  const tasksWithRemainingHours = pendingTasks.map(task => ({
    ...task,
    remainingHours: calculateRemainingTaskHours(task, workingPlans)
  })).filter(task => task.remainingHours > 0); // Only tasks with remaining work
  
  console.log('📊 Tasks with remaining hours:', tasksWithRemainingHours.map(t => ({
    title: t.title,
    total: t.estimatedHours,
    remaining: t.remainingHours
  })));
  
  if (tasksWithRemainingHours.length === 0) {
    console.log('✅ No tasks with remaining hours to schedule');
    return workingPlans;
  }
  
  // Remove only unlocked sessions for tasks that need rescheduling
  tasksWithRemainingHours.forEach(task => {
    removeUnlockedTaskSessions(task.id, workingPlans);
  });
  
  // Generate new sessions based on study plan mode
  switch (settings.studyPlanMode) {
    case 'eisenhower':
      return generateEisenhowerPlan(tasksWithRemainingHours, workingPlans, settings, fixedCommitments);
    case 'balanced':
      return generateBalancedPriorityPlan(tasksWithRemainingHours, workingPlans, settings, fixedCommitments);
    case 'even':
    default:
      return generateEvenDistributionPlan(tasksWithRemainingHours, workingPlans, settings, fixedCommitments);
  }
}

/**
 * Generate Eisenhower Matrix based plan (respects locked days)
 */
function generateEisenhowerPlan(
  tasks: Array<Task & { remainingHours: number }>,
  workingPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
): StudyPlan[] {
  console.log('🎯 Generating Eisenhower Matrix plan...');
  
  // Categorize tasks into Eisenhower quadrants
  const quadrants = categorizeTasksEisenhower(tasks);
  
  // Schedule in priority order: Q1 → Q2 → Q3 → Q4
  const priorityOrder = [
    ...quadrants.importantUrgent,
    ...quadrants.importantNotUrgent,
    ...quadrants.notImportantUrgent,
    ...quadrants.notImportantNotUrgent
  ];
  
  // Schedule each task based on its quadrant strategy
  priorityOrder.forEach(task => {
    const strategy = getTaskDistributionStrategy(task, quadrants);
    scheduleTaskWithStrategy(task, strategy, workingPlans, settings, fixedCommitments);
  });
  
  return workingPlans;
}

/**
 * Generate Balanced Priority plan (respects locked days)
 */
function generateBalancedPriorityPlan(
  tasks: Array<Task & { remainingHours: number }>,
  workingPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
): StudyPlan[] {
  console.log('⚖️ Generating Balanced Priority plan...');
  
  // Group tasks by importance
  const importantTasks = tasks.filter(task => task.importance);
  const regularTasks = tasks.filter(task => !task.importance);
  
  // Schedule important tasks first with even distribution
  importantTasks.forEach(task => {
    scheduleTaskWithStrategy(task, 'even', workingPlans, settings, fixedCommitments);
  });
  
  // Then schedule regular tasks with remaining time
  regularTasks.forEach(task => {
    scheduleTaskWithStrategy(task, 'even', workingPlans, settings, fixedCommitments);
  });
  
  return workingPlans;
}

/**
 * Generate Even Distribution plan (respects locked days)
 */
function generateEvenDistributionPlan(
  tasks: Array<Task & { remainingHours: number }>,
  workingPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
): StudyPlan[] {
  console.log('📊 Generating Even Distribution plan...');
  
  // Sort tasks by deadline and importance
  const sortedTasks = [...tasks].sort((a, b) => {
    if (a.importance !== b.importance) return a.importance ? -1 : 1;
    return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
  });
  
  // Schedule each task with even distribution
  sortedTasks.forEach(task => {
    scheduleTaskWithStrategy(task, 'even', workingPlans, settings, fixedCommitments);
  });
  
  return workingPlans;
}

/**
 * Schedule a task using the specified distribution strategy, respecting locked days
 */
function scheduleTaskWithStrategy(
  task: Task & { remainingHours: number },
  strategy: 'front-load' | 'even' | 'back-load',
  workingPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
): void {
  if (task.remainingHours <= 0) return;
  
  console.log(`📅 Scheduling ${task.title} (${task.remainingHours}h remaining) with ${strategy} strategy`);
  
  // Calculate available days (excluding locked days and considering deadline)
  const availableDays = getAvailableDaysForTask(task, workingPlans, settings);
  
  if (availableDays.length === 0) {
    console.warn(`⚠️ No available days for task: ${task.title}`);
    return;
  }
  
  // Calculate daily hours distribution based on strategy
  const dailyHoursDistribution = calculateDailyHoursDistribution(
    task.remainingHours,
    availableDays.length,
    strategy
  );
  
  console.log(`📈 Daily distribution for ${task.title}:`, dailyHoursDistribution);
  
  // Schedule sessions on available days
  let sessionNumber = getNextSessionNumber(task.id, workingPlans);
  
  for (let i = 0; i < Math.min(dailyHoursDistribution.length, availableDays.length); i++) {
    const dayDate = availableDays[i];
    const hoursForDay = dailyHoursDistribution[i];
    
    if (hoursForDay > 0) {
      const timeSlot = findNextAvailableTimeSlot(
        hoursForDay,
        dayDate,
        workingPlans,
        settings,
        fixedCommitments,
        1 // Only search this specific day
      );
      
      if (timeSlot && timeSlot.date === dayDate) {
        const session: StudySession = {
          taskId: task.id,
          scheduledTime: `${dayDate} ${timeSlot.startTime}`,
          startTime: timeSlot.startTime,
          endTime: timeSlot.endTime,
          allocatedHours: hoursForDay,
          sessionNumber: sessionNumber++,
          isFlexible: true,
          status: 'scheduled'
        };
        
        addSessionToPlan(session, dayDate, workingPlans, settings);
        console.log(`✅ Scheduled ${task.title} session ${session.sessionNumber} on ${dayDate}: ${hoursForDay}h`);
      } else {
        console.warn(`⚠️ Could not find time slot for ${task.title} on ${dayDate} (${hoursForDay}h)`);
      }
    }
  }
}

/**
 * Get available days for a task, excluding locked days
 */
function getAvailableDaysForTask(
  task: Task & { remainingHours: number },
  workingPlans: StudyPlan[],
  settings: UserSettings
): string[] {
  const today = getLocalDateString();
  const deadline = new Date(task.deadline);
  
  // Apply buffer days
  if (settings.bufferDays > 0) {
    deadline.setDate(deadline.getDate() - settings.bufferDays);
  }
  
  const availableDays: string[] = [];
  const currentDate = new Date(today);
  
  // Find all work days between today and deadline, excluding locked days
  while (currentDate <= deadline) {
    const dateString = currentDate.toISOString().split('T')[0];
    const dayOfWeek = currentDate.getDay();
    
    // Check if it's a work day
    if (settings.workDays.includes(dayOfWeek)) {
      // Check if day is not locked
      const dayPlan = workingPlans.find(plan => plan.date === dateString);
      if (!dayPlan?.isLocked) {
        availableDays.push(dateString);
      }
    }
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return availableDays;
}

/**
 * Get the next session number for a task
 */
function getNextSessionNumber(taskId: string, studyPlans: StudyPlan[]): number {
  let maxSessionNumber = 0;
  
  studyPlans.forEach(plan => {
    plan.plannedTasks.forEach(session => {
      if (session.taskId === taskId && session.sessionNumber) {
        maxSessionNumber = Math.max(maxSessionNumber, session.sessionNumber);
      }
    });
  });
  
  return maxSessionNumber + 1;
}

/**
 * Add a session to the appropriate plan, creating the plan if it doesn't exist
 */
function addSessionToPlan(
  session: StudySession,
  date: string,
  workingPlans: StudyPlan[],
  settings: UserSettings
): void {
  let plan = workingPlans.find(p => p.date === date);
  
  if (!plan) {
    plan = {
      id: `plan-${date}`,
      date,
      plannedTasks: [],
      totalStudyHours: 0,
      availableHours: settings.dailyAvailableHours,
      isLocked: false
    };
    workingPlans.push(plan);
  }
  
  // Don't add sessions to locked days
  if (plan.isLocked) {
    console.warn(`⚠️ Attempted to add session to locked day: ${date}`);
    return;
  }
  
  plan.plannedTasks.push(session);
  plan.totalStudyHours = plan.plannedTasks
    .filter(s => s.status !== 'skipped')
    .reduce((sum, s) => sum + s.allocatedHours, 0);
}

/**
 * Categorize tasks into Eisenhower Matrix quadrants
 */
function categorizeTasksEisenhower(tasks: Array<Task & { remainingHours: number }>) {
  const now = new Date();
  
  const quadrants = {
    importantUrgent: [] as Array<Task & { remainingHours: number }>,
    importantNotUrgent: [] as Array<Task & { remainingHours: number }>,
    notImportantUrgent: [] as Array<Task & { remainingHours: number }>,
    notImportantNotUrgent: [] as Array<Task & { remainingHours: number }>
  };
  
  tasks.forEach(task => {
    const deadline = new Date(task.deadline);
    const daysUntilDeadline = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const isUrgent = daysUntilDeadline <= 3;
    
    if (task.importance && isUrgent) {
      quadrants.importantUrgent.push(task);
    } else if (task.importance && !isUrgent) {
      quadrants.importantNotUrgent.push(task);
    } else if (!task.importance && isUrgent) {
      quadrants.notImportantUrgent.push(task);
    } else {
      quadrants.notImportantNotUrgent.push(task);
    }
  });
  
  return quadrants;
}

/**
 * Get distribution strategy for a task based on its quadrant
 */
function getTaskDistributionStrategy(
  task: Task & { remainingHours: number },
  quadrants: ReturnType<typeof categorizeTasksEisenhower>
): 'front-load' | 'even' | 'back-load' {
  if (quadrants.importantUrgent.includes(task)) {
    return 'front-load'; // Do important urgent tasks ASAP
  } else if (quadrants.importantNotUrgent.includes(task)) {
    return 'even'; // Spread important non-urgent tasks evenly
  } else if (quadrants.notImportantUrgent.includes(task)) {
    return 'front-load'; // Handle urgent tasks quickly
  } else {
    return 'back-load'; // Defer non-important, non-urgent tasks
  }
}

/**
 * Calculate daily hours distribution based on strategy
 */
function calculateDailyHoursDistribution(
  totalHours: number,
  availableDays: number,
  strategy: 'front-load' | 'even' | 'back-load'
): number[] {
  if (availableDays === 0) return [];
  
  const distribution: number[] = new Array(availableDays).fill(0);
  
  switch (strategy) {
    case 'front-load':
      return distributeFrontLoad(totalHours, availableDays);
    case 'back-load':
      return distributeBackLoad(totalHours, availableDays);
    case 'even':
    default:
      return distributeEvenly(totalHours, availableDays);
  }
}

function distributeEvenly(totalHours: number, days: number): number[] {
  const baseHours = Math.floor((totalHours * 100) / days) / 100; // Round to 2 decimal places
  const remainder = Math.round((totalHours - baseHours * days) * 100) / 100;
  
  const distribution = new Array(days).fill(baseHours);
  
  // Distribute remainder to first few days
  let remainingToDistribute = remainder;
  for (let i = 0; i < days && remainingToDistribute > 0; i++) {
    const increment = Math.min(0.25, remainingToDistribute); // Add in 15-minute increments
    distribution[i] += increment;
    remainingToDistribute = Math.round((remainingToDistribute - increment) * 100) / 100;
  }
  
  return distribution;
}

function distributeFrontLoad(totalHours: number, days: number): number[] {
  const distribution = new Array(days).fill(0);
  
  // 70% in first third, 20% in second third, 10% in final third
  const firstThird = Math.ceil(days / 3);
  const secondThird = Math.ceil((days * 2) / 3);
  
  const firstThirdHours = totalHours * 0.7;
  const secondThirdHours = totalHours * 0.2;
  const finalThirdHours = totalHours * 0.1;
  
  // Distribute first third
  const firstThirdDaily = distributeEvenly(firstThirdHours, firstThird);
  for (let i = 0; i < firstThird; i++) {
    distribution[i] = firstThirdDaily[i] || 0;
  }
  
  // Distribute second third
  const secondThirdDays = secondThird - firstThird;
  if (secondThirdDays > 0) {
    const secondThirdDaily = distributeEvenly(secondThirdHours, secondThirdDays);
    for (let i = 0; i < secondThirdDays; i++) {
      distribution[firstThird + i] = secondThirdDaily[i] || 0;
    }
  }
  
  // Distribute final third
  const finalThirdDays = days - secondThird;
  if (finalThirdDays > 0) {
    const finalThirdDaily = distributeEvenly(finalThirdHours, finalThirdDays);
    for (let i = 0; i < finalThirdDays; i++) {
      distribution[secondThird + i] = finalThirdDaily[i] || 0;
    }
  }
  
  return distribution;
}

function distributeBackLoad(totalHours: number, days: number): number[] {
  const distribution = new Array(days).fill(0);
  
  // 10% in first third, 20% in second third, 70% in final third
  const firstThird = Math.ceil(days / 3);
  const secondThird = Math.ceil((days * 2) / 3);
  
  const firstThirdHours = totalHours * 0.1;
  const secondThirdHours = totalHours * 0.2;
  const finalThirdHours = totalHours * 0.7;
  
  // Distribute first third
  const firstThirdDaily = distributeEvenly(firstThirdHours, firstThird);
  for (let i = 0; i < firstThird; i++) {
    distribution[i] = firstThirdDaily[i] || 0;
  }
  
  // Distribute second third
  const secondThirdDays = secondThird - firstThird;
  if (secondThirdDays > 0) {
    const secondThirdDaily = distributeEvenly(secondThirdHours, secondThirdDays);
    for (let i = 0; i < secondThirdDays; i++) {
      distribution[firstThird + i] = secondThirdDaily[i] || 0;
    }
  }
  
  // Distribute final third
  const finalThirdDays = days - secondThird;
  if (finalThirdDays > 0) {
    const finalThirdDaily = distributeEvenly(finalThirdHours, finalThirdDays);
    for (let i = 0; i < finalThirdDays; i++) {
      distribution[secondThird + i] = finalThirdDaily[i] || 0;
    }
  }
  
  return distribution;
}

/**
 * Enhanced redistribution that respects locked days
 */
export function redistributeMissedSessionsWithFeedback(
  studyPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  tasks: Task[]
): {
  updatedPlans: StudyPlan[];
  movedSessions: StudySession[];
  failedSessions: StudySession[];
  feedback: {
    success: boolean;
    message: string;
    details: {
      totalMissed: number;
      successfullyMoved: number;
      failedToMove: number;
      conflictsDetected: boolean;
      priorityOrderUsed: boolean;
      issues: string[];
      suggestions: string[];
    };
  };
} {
  console.log('🔄 Starting enhanced missed session redistribution...');
  
  const today = getLocalDateString();
  const workingPlans = JSON.parse(JSON.stringify(studyPlans)) as StudyPlan[];
  
  // Collect missed sessions from unlocked days only
  const missedSessions: Array<{
    session: StudySession;
    planDate: string;
    task: Task;
    priority: number;
  }> = [];
  
  workingPlans.forEach(plan => {
    // Skip locked days - don't redistribute sessions from locked days
    if (plan.isLocked || plan.date >= today) return;
    
    plan.plannedTasks.forEach(session => {
      const sessionStatus = checkSessionStatus(session, plan.date);
      if (sessionStatus === 'missed' && session.status !== 'skipped') {
        const task = tasks.find(t => t.id === session.taskId);
        if (task && task.status === 'pending') {
          let priority = 0;
          
          // Calculate priority
          if (task.importance) priority += 1000;
          
          const daysUntilDeadline = Math.max(0, (new Date(task.deadline).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
          if (daysUntilDeadline < 0) {
            priority += 2000; // Very high priority for past deadlines
          } else {
            priority += Math.max(0, 100 - daysUntilDeadline);
          }
          
          missedSessions.push({
            session,
            planDate: plan.date,
            task,
            priority
          });
        }
      }
    });
  });
  
  console.log(`📊 Found ${missedSessions.length} missed sessions to redistribute`);
  
  if (missedSessions.length === 0) {
    return {
      updatedPlans: workingPlans,
      movedSessions: [],
      failedSessions: [],
      feedback: {
        success: true,
        message: 'No missed sessions found to redistribute.',
        details: {
          totalMissed: 0,
          successfullyMoved: 0,
          failedToMove: 0,
          conflictsDetected: false,
          priorityOrderUsed: false,
          issues: [],
          suggestions: []
        }
      }
    };
  }
  
  // Sort by priority (highest first)
  missedSessions.sort((a, b) => b.priority - a.priority);
  
  const movedSessions: StudySession[] = [];
  const failedSessions: StudySession[] = [];
  
  // Process each missed session
  missedSessions.forEach(({ session, planDate, task }) => {
    console.log(`🔄 Redistributing ${task.title} session from ${planDate}`);
    
    // Calculate deadline with buffer
    const deadline = new Date(task.deadline);
    if (settings.bufferDays > 0) {
      deadline.setDate(deadline.getDate() - settings.bufferDays);
    }
    
    // Find next available slot, excluding locked days
    const timeSlot = findNextAvailableTimeSlot(
      session.allocatedHours,
      today,
      workingPlans,
      settings,
      fixedCommitments,
      Math.ceil((deadline.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
    );
    
    if (timeSlot) {
      // Remove original session from unlocked day
      const originalPlan = workingPlans.find(p => p.date === planDate);
      if (originalPlan && !originalPlan.isLocked) {
        const sessionIndex = originalPlan.plannedTasks.findIndex(
          s => s.taskId === session.taskId && s.sessionNumber === session.sessionNumber
        );
        if (sessionIndex !== -1) {
          originalPlan.plannedTasks.splice(sessionIndex, 1);
          originalPlan.totalStudyHours = originalPlan.plannedTasks
            .filter(s => s.status !== 'skipped')
            .reduce((sum, s) => sum + s.allocatedHours, 0);
        }
      }
      
      // Create new session with redistribution metadata
      const newSession: StudySession = {
        ...session,
        startTime: timeSlot.startTime,
        endTime: timeSlot.endTime,
        status: 'rescheduled',
        isManualOverride: false, // This is automatic redistribution
        originalTime: session.startTime,
        originalDate: planDate,
        rescheduledAt: new Date().toISOString()
      };
      
      addSessionToPlan(newSession, timeSlot.date, workingPlans, settings);
      movedSessions.push(newSession);
      
      console.log(`✅ Moved ${task.title} session to ${timeSlot.date} ${timeSlot.startTime}-${timeSlot.endTime}`);
    } else {
      failedSessions.push(session);
      console.warn(`❌ Could not find slot for ${task.title} session`);
    }
  });
  
  // Generate feedback
  const feedback = {
    success: movedSessions.length > 0,
    message: movedSessions.length > 0 
      ? `Successfully redistributed ${movedSessions.length} of ${missedSessions.length} missed sessions.`
      : `Could not redistribute any of the ${missedSessions.length} missed sessions.`,
    details: {
      totalMissed: missedSessions.length,
      successfullyMoved: movedSessions.length,
      failedToMove: failedSessions.length,
      conflictsDetected: failedSessions.length > 0,
      priorityOrderUsed: true,
      issues: failedSessions.length > 0 ? ['Some sessions could not be redistributed due to scheduling conflicts'] : [],
      suggestions: failedSessions.length > 0 ? [
        'Consider increasing daily available hours',
        'Add more work days to your schedule',
        'Extend task deadlines if possible'
      ] : []
    }
  };
  
  return {
    updatedPlans: workingPlans,
    movedSessions,
    failedSessions,
    feedback
  };
}

/**
 * Validate that locked days are not modified during redistribution
 */
export function validateLockedDaysIntegrity(
  originalPlans: StudyPlan[],
  updatedPlans: StudyPlan[]
): { isValid: boolean; violations: string[] } {
  const violations: string[] = [];
  
  originalPlans.forEach(originalPlan => {
    if (originalPlan.isLocked) {
      const updatedPlan = updatedPlans.find(p => p.date === originalPlan.date);
      
      if (!updatedPlan) {
        violations.push(`Locked day ${originalPlan.date} was removed`);
        return;
      }
      
      if (!updatedPlan.isLocked) {
        violations.push(`Day ${originalPlan.date} lost its locked status`);
      }
      
      // Check if sessions were modified
      if (originalPlan.plannedTasks.length !== updatedPlan.plannedTasks.length) {
        violations.push(`Locked day ${originalPlan.date} had sessions added or removed`);
      }
      
      // Check individual sessions
      originalPlan.plannedTasks.forEach((originalSession, index) => {
        const updatedSession = updatedPlan.plannedTasks[index];
        if (!updatedSession || 
            originalSession.startTime !== updatedSession.startTime ||
            originalSession.endTime !== updatedSession.endTime ||
            originalSession.allocatedHours !== updatedSession.allocatedHours) {
          violations.push(`Session modified on locked day ${originalPlan.date}`);
        }
      });
    }
  });
  
  return {
    isValid: violations.length === 0,
    violations
  };
}

/**
 * Check for frequency deadline conflicts
 */
export function checkFrequencyDeadlineConflict(
  task: {
    deadline: string;
    estimatedHours: number;
    targetFrequency?: string;
    deadlineType?: string;
    minWorkBlock?: number;
  },
  settings: UserSettings
): {
  hasConflict: boolean;
  reason?: string;
  recommendedFrequency?: string;
} {
  if (!task.deadline || task.deadlineType === 'none') {
    return { hasConflict: false };
  }

  const now = new Date();
  const deadline = new Date(task.deadline);
  const daysUntilDeadline = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  
  // Apply buffer days
  const effectiveDays = Math.max(1, daysUntilDeadline - (settings.bufferDays || 0));
  
  // Calculate work days available
  const workDaysInPeriod = Math.ceil(effectiveDays * (settings.workDays.length / 7));
  
  // Calculate sessions needed based on frequency
  let sessionsNeeded = 0;
  const minWorkBlockHours = (task.minWorkBlock || 30) / 60;
  
  switch (task.targetFrequency) {
    case 'daily':
      sessionsNeeded = workDaysInPeriod;
      break;
    case '3x-week':
      sessionsNeeded = Math.ceil(effectiveDays / 7) * 3;
      break;
    case 'weekly':
      sessionsNeeded = Math.ceil(effectiveDays / 7);
      break;
    case 'flexible':
      sessionsNeeded = Math.ceil(task.estimatedHours / Math.min(4, settings.dailyAvailableHours));
      break;
    default:
      sessionsNeeded = workDaysInPeriod;
  }
  
  const maxHoursPerSession = Math.min(4, settings.dailyAvailableHours);
  const maxTotalHours = sessionsNeeded * maxHoursPerSession;
  
  if (task.estimatedHours > maxTotalHours) {
    let recommendedFrequency = 'daily';
    if (task.estimatedHours <= workDaysInPeriod * maxHoursPerSession) {
      recommendedFrequency = 'daily';
    }
    
    return {
      hasConflict: true,
      reason: `${task.targetFrequency} frequency allows only ${sessionsNeeded} sessions (${formatTime(maxTotalHours)}) but task needs ${formatTime(task.estimatedHours)}`,
      recommendedFrequency
    };
  }
  
  return { hasConflict: false };
}

/**
 * Check commitment conflicts
 */
export function checkCommitmentConflicts(
  newCommitment: {
    title: string;
    startTime: string;
    endTime: string;
    recurring: boolean;
    daysOfWeek: number[];
    specificDates?: string[];
  },
  existingCommitments: FixedCommitment[],
  excludeCommitmentId?: string
): {
  hasConflict: boolean;
  conflictType?: 'strict' | 'override';
  conflictingCommitment?: FixedCommitment;
  conflictingDates?: string[];
} {
  const newStart = timeStringToMinutes(newCommitment.startTime);
  const newEnd = timeStringToMinutes(newCommitment.endTime);
  
  for (const existing of existingCommitments) {
    if (excludeCommitmentId && existing.id === excludeCommitmentId) {
      continue;
    }
    
    const existingStart = timeStringToMinutes(existing.startTime);
    const existingEnd = timeStringToMinutes(existing.endTime);
    
    // Check for time overlap
    if (newStart < existingEnd && newEnd > existingStart) {
      // Check for date overlap
      if (newCommitment.recurring && existing.recurring) {
        // Both recurring - check day overlap
        const dayOverlap = newCommitment.daysOfWeek.some(day => existing.daysOfWeek.includes(day));
        if (dayOverlap) {
          return {
            hasConflict: true,
            conflictType: 'strict',
            conflictingCommitment: existing
          };
        }
      } else if (!newCommitment.recurring && !existing.recurring) {
        // Both one-time - check specific date overlap
        const dateOverlap = newCommitment.specificDates?.some(date => 
          existing.specificDates?.includes(date)
        );
        if (dateOverlap) {
          return {
            hasConflict: true,
            conflictType: 'strict',
            conflictingCommitment: existing
          };
        }
      } else {
        // Mixed types - this is an override situation
        return {
          hasConflict: true,
          conflictType: 'override',
          conflictingCommitment: existing,
          conflictingDates: newCommitment.specificDates || []
        };
      }
    }
  }
  
  return { hasConflict: false };
}

/**
 * Combine sessions on the same day for the same task, respecting locked days
 */
export function combineSessionsOnSameDay(studyPlans: StudyPlan[], settings: UserSettings): StudyPlan[] {
  const updatedPlans = [...studyPlans];
  
  updatedPlans.forEach(plan => {
    // Skip locked days - don't modify sessions on locked days
    if (plan.isLocked) return;
    
    const taskGroups: { [taskId: string]: StudySession[] } = {};
    
    // Group sessions by task
    plan.plannedTasks.forEach(session => {
      if (session.status !== 'skipped' && !session.done && session.status !== 'completed') {
        if (!taskGroups[session.taskId]) {
          taskGroups[session.taskId] = [];
        }
        taskGroups[session.taskId].push(session);
      }
    });
    
    // Combine sessions for each task
    Object.entries(taskGroups).forEach(([taskId, sessions]) => {
      if (sessions.length > 1) {
        // Sort sessions by start time
        sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
        
        // Calculate total hours
        const totalHours = sessions.reduce((sum, session) => sum + session.allocatedHours, 0);
        
        // Check if combined session would be within limits
        const maxSessionLength = Math.min(4, settings.dailyAvailableHours);
        const minSessionLength = (settings.minSessionLength || 15) / 60;
        
        if (totalHours >= minSessionLength && totalHours <= maxSessionLength) {
          // Create combined session
          const combinedSession: StudySession = {
            ...sessions[0],
            endTime: addHoursToTime(sessions[0].startTime, totalHours),
            allocatedHours: totalHours,
            sessionNumber: Math.min(...sessions.map(s => s.sessionNumber || 1))
          };
          
          // Remove original sessions and add combined session
          plan.plannedTasks = plan.plannedTasks.filter(session => 
            session.taskId !== taskId || 
            session.done || 
            session.status === 'completed' || 
            session.status === 'skipped'
          );
          plan.plannedTasks.push(combinedSession);
          
          console.log(`🔗 Combined ${sessions.length} sessions for ${taskId} on ${plan.date}: ${formatTime(totalHours)}`);
        }
      }
    });
    
    // Recalculate total study hours
    plan.totalStudyHours = plan.plannedTasks
      .filter(session => session.status !== 'skipped')
      .reduce((sum, session) => sum + session.allocatedHours, 0);
  });
  
  return updatedPlans;
}

/**
 * Check if a day can be locked (has no pending/scheduled sessions)
 */
export function canLockDay(date: string, studyPlans: StudyPlan[]): {
  canLock: boolean;
  reason?: string;
  pendingSessions?: number;
} {
  const plan = studyPlans.find(p => p.date === date);
  
  if (!plan) {
    return { canLock: true };
  }
  
  const pendingSessions = plan.plannedTasks.filter(session => 
    !session.done && 
    session.status !== 'completed' && 
    session.status !== 'skipped' &&
    session.status !== 'missed'
  );
  
  if (pendingSessions.length > 0) {
    return {
      canLock: false,
      reason: `Day has ${pendingSessions.length} pending session${pendingSessions.length > 1 ? 's' : ''}`,
      pendingSessions: pendingSessions.length
    };
  }
  
  return { canLock: true };
}

/**
 * Lock a day and prevent further modifications
 */
export function lockDay(date: string, studyPlans: StudyPlan[]): boolean {
  const lockCheck = canLockDay(date, studyPlans);
  
  if (!lockCheck.canLock) {
    console.warn(`Cannot lock day ${date}: ${lockCheck.reason}`);
    return false;
  }
  
  let plan = studyPlans.find(p => p.date === date);
  
  if (!plan) {
    // Create empty locked plan
    plan = {
      id: `plan-${date}`,
      date,
      plannedTasks: [],
      totalStudyHours: 0,
      availableHours: 0,
      isLocked: true
    };
    studyPlans.push(plan);
  } else {
    plan.isLocked = true;
  }
  
  console.log(`🔒 Locked day: ${date}`);
  return true;
}

/**
 * Unlock a day and allow modifications
 */
export function unlockDay(date: string, studyPlans: StudyPlan[], settings: UserSettings): boolean {
  const plan = studyPlans.find(p => p.date === date);
  
  if (!plan) {
    console.warn(`No plan found for date: ${date}`);
    return false;
  }
  
  plan.isLocked = false;
  plan.availableHours = settings.dailyAvailableHours;
  
  console.log(`🔓 Unlocked day: ${date}`);
  return true;
}

/**
 * Get locked sessions count for a task
 */
export function getLockedSessionsCount(taskId: string, studyPlans: StudyPlan[]): number {
  let lockedSessions = 0;
  
  studyPlans.forEach(plan => {
    if (plan.isLocked) {
      plan.plannedTasks.forEach(session => {
        if (session.taskId === taskId) {
          lockedSessions++;
        }
      });
    }
  });
  
  return lockedSessions;
}

/**
 * Get locked hours for a task
 */
export function getLockedHoursForTask(taskId: string, studyPlans: StudyPlan[]): number {
  let lockedHours = 0;
  
  studyPlans.forEach(plan => {
    if (plan.isLocked) {
      plan.plannedTasks.forEach(session => {
        if (session.taskId === taskId) {
          lockedHours += session.allocatedHours;
        }
      });
    }
  });
  
  return lockedHours;
}